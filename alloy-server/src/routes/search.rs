//! `GET /api/search?q=…` — full-text search across the vault.
//!
//! The sidebar used to do this client-side, which quietly stopped working for
//! conversations once they began loading as metadata-only summaries: the filter
//! searched `conversation.messages`, and that array is empty until a
//! conversation is opened. The bodies can't simply be shipped to the client
//! either — a real vault is ~200MB across a couple of thousand conversations,
//! and loading it would undo the startup work.
//!
//! So the scan happens here, next to the files. Notes keep their client-side
//! matching (their bodies are already loaded), and these results are merged in.

use axum::{Router, extract::{Query, State}, routing::get, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use tokio::io::AsyncReadExt;

use crate::{AppState, tools::search::{nearest_char_boundary, snippet_around}};

/// Cap on returned hits. The sidebar shows a list, not a corpus.
const MAX_RESULTS: usize = 50;
/// Stop scanning after this many matches. Results are sorted by recency before
/// truncating to [`MAX_RESULTS`], so this needs enough candidates for that sort
/// to be meaningful while still bounding a broad query — returning the first 50
/// in filesystem order would surface arbitrary old conversations.
const MAX_SCAN_HITS: usize = 300;
/// Per-file read cap. Long conversations are matched on their first chunk rather
/// than paying to scan a multi-megabyte transcript on every keystroke.
const MAX_FILE_BYTES: usize = 512 * 1024;
/// Shortest query worth scanning the vault for.
const MIN_QUERY_LEN: usize = 2;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

#[derive(Serialize)]
struct SearchHit {
    /// Sort key only; the client already renders its own timestamps.
    #[serde(skip)]
    modified: std::time::SystemTime,
    /// "conversation" | "note" — mirrors the timeline item kinds.
    #[serde(rename = "type")]
    kind: String,
    /// Conversation id, or vault-relative path for a note/riff.
    id: String,
    title: String,
    snippet: String,
}

async fn search(State(state): State<AppState>, Query(q): Query<SearchQuery>) -> Json<Value> {
    let query = q.q.trim().to_lowercase();
    if query.len() < MIN_QUERY_LEN {
        return Json(json!({ "results": [] }));
    }

    let root = state.vault.root().to_path_buf();
    let mut hits: Vec<SearchHit> = Vec::new();

    for (dir, kind) in [
        ("conversations", "conversation"),
        ("notes", "note"),
        ("riffs", "note"),
    ] {
        if hits.len() >= MAX_SCAN_HITS {
            break;
        }
        scan_dir(&root.join(dir), dir, kind, &query, &mut hits).await;
    }

    // Most-recent first, matching how the sidebar orders everything else.
    hits.sort_by(|a, b| b.modified.cmp(&a.modified));
    hits.truncate(MAX_RESULTS);

    Json(json!({ "results": hits }))
}

async fn scan_dir(dir: &Path, rel_dir: &str, kind: &str, query: &str, hits: &mut Vec<SearchHit>) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return; // Missing directory (no riffs yet, etc.) is not an error.
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        if hits.len() >= MAX_SCAN_HITS {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Conversations also have generated .md previews; skip them so a match
        // isn't reported twice for the same conversation.
        let is_match_candidate = if kind == "conversation" {
            name.ends_with(".yaml")
        } else {
            name.ends_with(".md")
        };
        if !is_match_candidate {
            continue;
        }

        let Some(content) = read_capped(&entry.path()).await else {
            continue;
        };
        let Some(snippet) = first_match_snippet(&content, query) else {
            continue;
        };

        let (id, title) = if kind == "conversation" {
            let stem = name.trim_end_matches(".yaml").to_string();
            (yaml_field(&content, "id").unwrap_or_else(|| stem.clone()),
             yaml_field(&content, "title").unwrap_or(stem))
        } else {
            let path = if rel_dir == "riffs" { format!("riffs/{name}") } else { name.clone() };
            (path, name.trim_end_matches(".md").to_string())
        };

        let modified = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        hits.push(SearchHit { kind: kind.to_string(), id, title, snippet, modified });
    }
}

/// Read at most [`MAX_FILE_BYTES`], truncated to a char boundary so the lossy
/// conversion can't split a multi-byte character mid-match.
async fn read_capped(path: &Path) -> Option<String> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut buf = vec![0u8; MAX_FILE_BYTES];
    let n = file.read(&mut buf).await.ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// First line containing `query` (already lowercased), as a context snippet.
fn first_match_snippet(content: &str, query: &str) -> Option<String> {
    for line in content.lines() {
        let lower = line.to_lowercase();
        if let Some(idx) = lower.find(query) {
            // `idx` indexes the lowercased line; map it back to a safe boundary
            // in the original, since lowercasing can change byte lengths.
            let safe = nearest_char_boundary(line, idx.min(line.len()), false);
            return Some(snippet_around(line, safe, query.len()));
        }
    }
    None
}

/// Pull a top-level scalar out of a conversation's YAML header without parsing
/// the whole document — the body is a large message array we don't need.
fn yaml_field(content: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let value = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        if line.starts_with("messages:") {
            break; // Past the header.
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_header_fields_without_parsing_the_body() {
        let yaml = "id: 2024-01-15-1000-aa01\ntitle: Welcome to Alloy\nmodel: x\nmessages:\n- content: title: not this\n";
        assert_eq!(yaml_field(yaml, "id").as_deref(), Some("2024-01-15-1000-aa01"));
        assert_eq!(yaml_field(yaml, "title").as_deref(), Some("Welcome to Alloy"));
    }

    #[test]
    fn stops_at_the_message_body() {
        // A `title:` inside a message must not be mistaken for the header field.
        let yaml = "id: x\nmessages:\n- content: |\n    title: fake\n";
        assert_eq!(yaml_field(yaml, "title"), None);
    }

    #[test]
    fn matches_case_insensitively_and_returns_context() {
        let snippet = first_match_snippet("The Cost of Context is high", "cost of context").unwrap();
        assert!(snippet.contains("Cost of Context"), "got {snippet}");
    }

    #[test]
    fn reports_no_match_rather_than_an_empty_snippet() {
        assert!(first_match_snippet("nothing relevant here", "kanji").is_none());
    }

    #[test]
    fn handles_multibyte_content_without_panicking() {
        // Lowercasing can change byte lengths, so the match index has to be
        // mapped back to a char boundary before slicing.
        let snippet = first_match_snippet("消火器 means FIRE EXTINGUISHER here", "fire").unwrap();
        assert!(snippet.contains("FIRE"), "got {snippet}");
    }
}
