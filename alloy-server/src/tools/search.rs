//! `search_directory` tool. Recursive substring search through allowed vault
//! directories. Ports [src/services/tools/builtin/search.ts](src/services/tools/builtin/search.ts)
//! literally — plain case-insensitive substring matching, no regex.

use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::fs;

use crate::tools::{ToolRegistry, input_string};

const MAX_RESULTS: usize = 50;
const DEFAULT_MAX_RESULTS: usize = 20;
const MAX_FILE_SIZE: usize = 100 * 1024;
const MAX_RECURSION_DEPTH: usize = 3;
const MAX_FILES_TO_SEARCH: usize = 500;
const SNIPPET_CONTEXT: usize = 50;

const READABLE_DIRS: &[&str] = &["notes/", "skills/", "conversations/"];
const TEXT_EXTENSIONS: &[&str] = &["md", "txt", "yaml", "yml", "json", "js", "ts", "css", "html"];

#[derive(Default, Serialize)]
struct SearchResult {
    path: String,
    matches: Vec<MatchInfo>,
}

#[derive(Serialize)]
struct MatchInfo {
    line: u32,
    snippet: String,
}

struct Counters {
    total_matches: usize,
    searched_files: usize,
}

pub async fn execute(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let directory = input_string(input, "directory").unwrap_or("").trim();
    let query = input_string(input, "query").unwrap_or("");
    if directory.is_empty() {
        return Err("Missing required parameter: directory".into());
    }
    if query.is_empty() {
        return Err("Missing required parameter: query".into());
    }
    if directory.contains("..") || directory.starts_with('/') {
        return Err("Invalid directory: must be relative and cannot contain \"..\"".into());
    }

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

    let search_content = input_string(input, "search_content")
        .map(|s| s != "false")
        .unwrap_or(true);
    let max_results = input_string(input, "max_results")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .min(MAX_RESULTS);
    let file_ext = input_string(input, "file_extension").map(|s| s.to_string());

    let search_path = registry.vault.resolve(directory).map_err(|e| e.to_string())?;
    if fs::metadata(&search_path).await.is_err() {
        return Err(format!("Directory not found: {}", directory));
    }

    let mut results: Vec<SearchResult> = Vec::new();
    let mut counters = Counters {
        total_matches: 0,
        searched_files: 0,
    };
    let query_lower = query.to_lowercase();

    search_recursive(
        &search_path,
        directory,
        &query_lower,
        search_content,
        file_ext.as_deref(),
        &mut results,
        &mut counters,
        max_results,
        0,
    )
    .await;

    let response = json!({
        "results": &results[..results.len().min(max_results)],
        "total_matches": counters.total_matches,
        "searched_files": counters.searched_files,
    });
    Ok(serde_json::to_string_pretty(&response).unwrap_or_default())
}

#[allow(clippy::too_many_arguments)]
async fn search_recursive(
    full_path: &Path,
    relative_path: &str,
    query_lower: &str,
    search_content: bool,
    file_ext: Option<&str>,
    results: &mut Vec<SearchResult>,
    counters: &mut Counters,
    max_results: usize,
    depth: usize,
) {
    // Avoid async recursion by managing a stack manually.
    let mut stack: Vec<(std::path::PathBuf, String, usize)> = vec![(
        full_path.to_path_buf(),
        relative_path.to_string(),
        depth,
    )];

    while let Some((full, rel, d)) = stack.pop() {
        if d > MAX_RECURSION_DEPTH {
            continue;
        }
        if results.len() >= max_results || counters.searched_files >= MAX_FILES_TO_SEARCH {
            break;
        }

        let mut entries = match fs::read_dir(&full).await {
            Ok(e) => e,
            Err(_) => continue,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            if results.len() >= max_results || counters.searched_files >= MAX_FILES_TO_SEARCH {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let file_type = match entry.file_type().await {
                Ok(t) => t,
                Err(_) => continue,
            };

            let entry_full = entry.path();
            let entry_rel = if rel.ends_with('/') {
                format!("{}{}", rel, name)
            } else {
                format!("{}/{}", rel, name)
            };

            if file_type.is_dir() {
                stack.push((entry_full, entry_rel, d + 1));
                continue;
            }

            // Extension filter
            if let Some(ext) = file_ext {
                let suffix = format!(".{}", ext);
                if !name.ends_with(&suffix) {
                    continue;
                }
            }
            if !is_text_file(&name) {
                continue;
            }

            counters.searched_files += 1;
            let filename_matches = name.to_lowercase().contains(query_lower);
            let mut content_matches: Vec<MatchInfo> = Vec::new();

            if search_content {
                if let Ok(meta) = fs::metadata(&entry_full).await {
                    if meta.len() as usize > MAX_FILE_SIZE {
                        continue;
                    }
                }
                if let Ok(content) = fs::read_to_string(&entry_full).await {
                    content_matches = find_matches(&content, query_lower);
                }
            }

            if filename_matches || !content_matches.is_empty() {
                counters.total_matches += content_matches.len().max(1);
                results.push(SearchResult {
                    path: entry_rel,
                    matches: content_matches,
                });
            }
        }
    }
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
}
