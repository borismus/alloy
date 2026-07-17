//! `search_directory` tool. Recursive substring search through allowed vault
//! directories. Ports [src/services/tools/builtin/search.ts](src/services/tools/builtin/search.ts)
//! literally — plain case-insensitive substring matching, no regex.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::fs;

use crate::tools::{ToolContext, ToolRegistry, input_bool, input_string, input_usize};

const MAX_LIMIT: usize = 50;
const DEFAULT_LIMIT: usize = 20;
const MAX_FILE_SIZE: usize = 200 * 1024;
const MAX_RECURSION_DEPTH: usize = 6;
const MAX_FILES_TO_SCAN: usize = 2000; // files we read content for
const MAX_CANDIDATES: usize = 50_000; // bound the (cheap) path/mtime walk
const SNIPPET_CONTEXT: usize = 60;

const READABLE_DIRS: &[&str] = &["notes/", "skills/", "conversations/"];
const TEXT_EXTENSIONS: &[&str] = &["md", "txt", "yaml", "yml", "json", "js", "ts", "css", "html"];

/// One matching file in the result page: path + recency + a single short snippet.
#[derive(Serialize)]
struct FileMatch {
    path: String,
    modified: String,
    #[serde(rename = "matchCount")]
    match_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    snippet: Option<String>,
}

/// A single content match (internal to `find_matches`).
struct MatchInfo {
    #[allow(dead_code)]
    line: u32,
    snippet: String,
}

/// ISO-8601 (RFC 3339, seconds) UTC string for a file mtime.
fn iso(t: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub async fn execute(
    registry: &ToolRegistry,
    ctx: &ToolContext,
    input: &Value,
) -> Result<String, String> {
    let directory = input_string(input, "directory").unwrap_or("").trim();
    let query = input_string(input, "query").unwrap_or("");
    if directory.is_empty() {
        return Err("Missing required parameter: directory".into());
    }
    if query.is_empty() {
        return Err("Missing required parameter: query".into());
    }

    // Private mount: searchable by local models only; cloud gets a generic
    // "not found" without touching disk.
    let private = crate::tools::private::is_private_path(directory);
    if private && !ctx.model_is_local {
        return Err(format!("Directory not found: {}", directory));
    }

    if directory.contains("..") || directory.starts_with('/') {
        return Err("Invalid directory: must be relative and cannot contain \"..\"".into());
    }

    if !private {
        let dir_normalized = if directory.ends_with('/') {
            directory.to_string()
        } else {
            format!("{}/", directory)
        };
        let allowed = READABLE_DIRS
            .iter()
            .any(|p| dir_normalized == *p || dir_normalized.starts_with(p));
        if !allowed {
            return Err(format!(
                "Access denied: search not allowed for directory \"{}\"",
                directory
            ));
        }
    }

    let search_content = input_bool(input, "search_content").unwrap_or(true);
    let limit = input_usize(input, "limit")
        .or_else(|| input_usize(input, "max_results")) // back-compat
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let offset = input_usize(input, "offset").unwrap_or(0);
    let file_ext = input_string(input, "file_extension").map(|s| s.to_string());

    // Private search roots resolve to an external absolute path; vault searches
    // go through the sandbox. Either way the label stays the request path so
    // result `path` fields read as `private/<alias>/…` or `notes/…`.
    let search_path = if private {
        match crate::tools::private::resolve_private_path(&registry.config, directory) {
            Ok(Some(abs)) => abs,
            _ => return Err(format!("Directory not found: {}", directory)),
        }
    } else {
        registry.vault.resolve(directory).map_err(|e| e.to_string())?
    };
    if fs::metadata(&search_path).await.is_err() {
        return Err(format!("Directory not found: {}", directory));
    }
    let excludes = if private {
        crate::tools::private::private_exclude_roots(&registry.config, directory)
    } else {
        Vec::new()
    };

    // Phase 1: gather candidate text files (path + mtime only — no content
    // reads), then order most-recent-first so both the scan and the result page
    // come from recent files rather than arbitrary fs order.
    let mut candidates =
        collect_candidates(&search_path, directory, file_ext.as_deref(), &excludes).await;
    candidates.sort_by(|a, b| b.2.cmp(&a.2));

    // Phase 2: scan content in recency order until offset+limit matches or the
    // content-read budget is hit.
    let query_lower = query.to_lowercase();
    let want = offset + limit;
    let mut matched: Vec<FileMatch> = Vec::new();
    let mut content_reads = 0usize;
    for (abs, rel, mtime) in candidates {
        if matched.len() >= want || content_reads >= MAX_FILES_TO_SCAN {
            break;
        }
        let filename_matches = Path::new(&rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase().contains(&query_lower))
            .unwrap_or(false);
        let mut count = 0usize;
        let mut snippet: Option<String> = None;
        if search_content {
            let size_ok = fs::metadata(&abs)
                .await
                .map(|m| (m.len() as usize) <= MAX_FILE_SIZE)
                .unwrap_or(false);
            if size_ok {
                content_reads += 1;
                if let Ok(content) = fs::read_to_string(&abs).await {
                    let ms = find_matches(&content, &query_lower);
                    count = ms.len();
                    snippet = ms.into_iter().next().map(|m| m.snippet);
                }
            }
        }
        if filename_matches || count > 0 {
            matched.push(FileMatch {
                path: rel,
                modified: iso(mtime),
                match_count: count.max(usize::from(filename_matches)),
                snippet,
            });
        }
    }

    let total_matched = matched.len();
    let page: Vec<&FileMatch> = matched.iter().skip(offset).take(limit).collect();
    let returned = page.len();
    let mut obj = json!({
        "directory": directory,
        "query": query,
        "offset": offset,
        "returned": returned,
        "files": page,
    });
    if offset + returned < total_matched {
        obj["nextOffset"] = json!(offset + returned);
    }
    Ok(serde_json::to_string_pretty(&obj).unwrap_or_default())
}

/// Walk `root` (bounded by depth and MAX_CANDIDATES), collecting text files as
/// `(abs_path, request-relative-path, mtime)`. Cheap: no content is read here.
/// Skips dotfiles and anything under `excludes`.
async fn collect_candidates(
    root: &Path,
    label: &str,
    file_ext: Option<&str>,
    excludes: &[PathBuf],
) -> Vec<(PathBuf, String, SystemTime)> {
    let mut out: Vec<(PathBuf, String, SystemTime)> = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), label.to_string(), 0)];

    while let Some((full, rel, depth)) = stack.pop() {
        if out.len() >= MAX_CANDIDATES {
            break;
        }
        let mut entries = match fs::read_dir(&full).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if out.len() >= MAX_CANDIDATES {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let entry_full = entry.path();
            if excludes.iter().any(|ex| entry_full.starts_with(ex)) {
                continue;
            }
            let file_type = match entry.file_type().await {
                Ok(t) => t,
                Err(_) => continue,
            };
            let entry_rel = if rel.ends_with('/') {
                format!("{}{}", rel, name)
            } else {
                format!("{}/{}", rel, name)
            };
            if file_type.is_dir() {
                if depth < MAX_RECURSION_DEPTH {
                    stack.push((entry_full, entry_rel, depth + 1));
                }
                continue;
            }
            if let Some(ext) = file_ext {
                if !name.ends_with(&format!(".{}", ext)) {
                    continue;
                }
            }
            if !is_text_file(&name) {
                continue;
            }
            let mtime = entry
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            out.push((entry_full, entry_rel, mtime));
        }
    }
    out
}

fn is_text_file(name: &str) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase());
    matches!(ext.as_deref(), Some(e) if TEXT_EXTENSIONS.contains(&e))
}

fn find_matches(content: &str, query_lower: &str) -> Vec<MatchInfo> {
    let mut out = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let lower = line.to_lowercase();
        if let Some(idx) = lower.find(query_lower) {
            let start = idx.saturating_sub(SNIPPET_CONTEXT);
            let end = (idx + query_lower.len() + SNIPPET_CONTEXT).min(line.len());
            // Snap to char boundaries
            let snippet_start = nearest_char_boundary(line, start, false);
            let snippet_end = nearest_char_boundary(line, end, true);
            let mut snippet = line[snippet_start..snippet_end].to_string();
            if snippet_start > 0 {
                snippet = format!("...{}", snippet);
            }
            if snippet_end < line.len() {
                snippet = format!("{}...", snippet);
            }
            out.push(MatchInfo {
                line: (i + 1) as u32,
                snippet,
            });
        }
    }
    out
}

/// Snap a byte offset to a char boundary in `s`. `forward=true` moves
/// right; `false` moves left. Keeps `find_matches` panic-free on multi-byte
/// content.
fn nearest_char_boundary(s: &str, mut idx: usize, forward: bool) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        if forward {
            idx += 1;
        } else {
            idx -= 1;
        }
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_substring_match() {
        let m = find_matches("Hello world\nfoo bar Hello\n", "hello");
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].line, 1);
        assert!(m[0].snippet.contains("Hello"));
        assert_eq!(m[1].line, 2);
    }

    #[test]
    fn snippet_truncation_with_ellipsis() {
        let long_line: String = "a".repeat(200) + "needle" + &"b".repeat(200);
        let m = find_matches(&long_line, "needle");
        assert_eq!(m.len(), 1);
        assert!(m[0].snippet.starts_with("..."));
        assert!(m[0].snippet.ends_with("..."));
        assert!(m[0].snippet.contains("needle"));
    }

    #[test]
    fn text_file_detection() {
        assert!(is_text_file("foo.md"));
        assert!(is_text_file("data.YAML"));
        assert!(!is_text_file("image.png"));
        assert!(!is_text_file("noext"));
    }

    // ---- private-mount search enforcement (local-only) ----
    use serde_json::json;
    use std::sync::Arc;

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "alloy-search-test-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p.canonicalize().unwrap())
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn registry_with_private(
        vault_dir: &std::path::Path,
        external_dir: &std::path::Path,
    ) -> Arc<ToolRegistry> {
        use crate::config::{Config, PrivateDir};
        use crate::providers::ProviderRegistry;
        use crate::skill_registry::SkillRegistry;
        use crate::vault::Vault;

        let config = Config {
            private_read_only_dirs: vec![PrivateDir {
                alias: "notes".into(),
                path: external_dir.to_path_buf(),
                exclude_dirs: Vec::new(),
            }],
            ..Config::default()
        };
        Arc::new(ToolRegistry::new(
            Arc::new(config),
            Arc::new(Vault::new(vault_dir.to_path_buf()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ))
    }

    fn ctx(model_is_local: bool) -> ToolContext {
        ToolContext {
            message_id: None,
            conversation_id: None,
            inside_subagent: false,
            model_is_local,
        }
    }

    #[tokio::test]
    async fn private_search_local_finds_cloud_denied() {
        let vault = TempDir::new("vault");
        let external = TempDir::new("ext");
        std::fs::write(external.0.join("note.md"), "the needle is here").unwrap();
        let reg = registry_with_private(&vault.0, &external.0);
        let input = json!({ "directory": "private/notes", "query": "needle" });

        // Local model finds the match; result path stays under the mount.
        let ok = execute(&reg, &ctx(true), &input).await.unwrap();
        assert!(ok.contains("needle"));
        assert!(ok.contains("private/notes/note.md"));
        assert!(!ok.contains(external.0.to_str().unwrap()));

        // Cloud model is denied and learns nothing.
        let err = execute(&reg, &ctx(false), &input).await.unwrap_err();
        assert!(!err.contains("needle"));
        assert!(!err.contains("note.md"));
    }
}
