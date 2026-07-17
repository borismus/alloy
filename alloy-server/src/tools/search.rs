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
const MAX_CANDIDATES: usize = 200_000; // sanity bound on the (cheap) path/mtime walk
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
    // Fuzzy = match files containing ALL query terms anywhere (order-independent),
    // vs. the default exact contiguous substring.
    let fuzzy = input_bool(input, "fuzzy").unwrap_or(false);
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
    let terms: Vec<String> = if fuzzy {
        query_lower.split_whitespace().map(str::to_string).collect()
    } else {
        Vec::new()
    };
    let want = offset + limit;
    let mut matched: Vec<FileMatch> = Vec::new();
    for (abs, rel, mtime) in candidates {
        // Recency-first: once the requested page is full we can stop. For rare
        // terms (few/no matches) this reads the whole vault — which is cheap
        // (grep over these notes is sub-second).
        if matched.len() >= want {
            break;
        }
        let filename_lower = Path::new(&rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        // Read content once (unless disabled or oversized).
        let content = if search_content {
            let size_ok = fs::metadata(&abs)
                .await
                .map(|m| (m.len() as usize) <= MAX_FILE_SIZE)
                .unwrap_or(false);
            if size_ok {
                fs::read_to_string(&abs).await.ok()
            } else {
                None
            }
        } else {
            None
        };

        let hit = if fuzzy {
            match content.as_deref() {
                Some(c) => fuzzy_match(c, &filename_lower, &terms),
                None if terms.iter().all(|t| filename_lower.contains(t)) => Some((terms.len(), None)),
                None => None,
            }
        } else {
            let fname = filename_lower.contains(&query_lower);
            let (count, snip) = match content.as_deref() {
                Some(c) => {
                    let ms = find_matches(c, &query_lower);
                    (ms.len(), ms.into_iter().next().map(|m| m.snippet))
                }
                None => (0, None),
            };
            if fname || count > 0 {
                Some((count.max(usize::from(fname)), snip))
            } else {
                None
            }
        };

        if let Some((count, snippet)) = hit {
            matched.push(FileMatch {
                path: rel,
                modified: iso(mtime),
                match_count: count,
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
            out.push(MatchInfo {
                line: (i + 1) as u32,
                snippet: snippet_around(line, idx, query_lower.len()),
            });
        }
    }
    out
}

/// Extract a `...context needle context...` snippet around a match at byte `idx`
/// (of length `match_len`) within `line`, snapped to char boundaries.
fn snippet_around(line: &str, idx: usize, match_len: usize) -> String {
    let start = idx.saturating_sub(SNIPPET_CONTEXT);
    let end = (idx + match_len + SNIPPET_CONTEXT).min(line.len());
    let s = nearest_char_boundary(line, start, false);
    let e = nearest_char_boundary(line, end, true);
    let mut snippet = line[s..e].to_string();
    if s > 0 {
        snippet = format!("...{}", snippet);
    }
    if e < line.len() {
        snippet = format!("{}...", snippet);
    }
    snippet
}

/// Fuzzy (multi-term) match: succeeds when EVERY term appears somewhere in the
/// content or filename (order-independent, not necessarily adjacent). Returns
/// (count of lines containing any term, first snippet) or None.
fn fuzzy_match(
    content: &str,
    filename_lower: &str,
    terms: &[String],
) -> Option<(usize, Option<String>)> {
    if terms.is_empty() {
        return None;
    }
    let content_lower = content.to_lowercase();
    if !terms
        .iter()
        .all(|t| content_lower.contains(t) || filename_lower.contains(t))
    {
        return None;
    }
    let mut count = 0usize;
    let mut snippet = None;
    for line in content.lines() {
        let ll = line.to_lowercase();
        if let Some((idx, len)) = terms
            .iter()
            .filter_map(|t| ll.find(t).map(|i| (i, t.len())))
            .min_by_key(|(i, _)| *i)
        {
            count += 1;
            if snippet.is_none() {
                snippet = Some(snippet_around(line, idx, len));
            }
        }
    }
    Some((count.max(1), snippet))
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

    #[tokio::test]
    async fn fuzzy_matches_nonadjacent_terms() {
        let vault = TempDir::new("vault-fz");
        let external = TempDir::new("ext-fz");
        std::fs::write(
            external.0.join("note.md"),
            "Water consumption is high in modern data centers.",
        )
        .unwrap();
        let reg = registry_with_private(&vault.0, &external.0);
        let dir = "private/notes";

        // Exact (default): "data center water" is not a contiguous substring → no hit.
        let exact = execute(&reg, &ctx(true), &json!({ "directory": dir, "query": "data center water" }))
            .await
            .unwrap();
        let ev: serde_json::Value = serde_json::from_str(&exact).unwrap();
        assert_eq!(ev["returned"], 0);

        // Fuzzy: all three terms present anywhere → one hit.
        let fz = execute(
            &reg,
            &ctx(true),
            &json!({ "directory": dir, "query": "data center water", "fuzzy": true }),
        )
        .await
        .unwrap();
        let fv: serde_json::Value = serde_json::from_str(&fz).unwrap();
        assert_eq!(fv["returned"], 1);
        assert!(fz.contains("note.md"));
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
                description: None,
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
