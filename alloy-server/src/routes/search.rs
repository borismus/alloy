//! `GET /api/search?q=…` — full-text search across the vault.
//!
//! The sidebar used to do this client-side, which quietly stopped working for
//! conversations once they began loading as metadata-only summaries: the filter
//! searched `conversation.messages`, and that array is empty until a
//! conversation is opened. The bodies can't simply be shipped to the client
//! either — a real vault is ~200MB across a couple of thousand conversations,
//! and loading it would undo the startup work.
//!
//! So the scan happens here, next to the files, and only matching ids/snippets
//! are returned. Note bodies are likewise no longer loaded by the client.

use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tokio::io::AsyncReadExt;

use crate::{
    tools::search::{nearest_char_boundary, snippet_around},
    AppState,
};

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

    let hits = search_vault(state.vault.root(), &query).await;
    Json(json!({ "results": hits }))
}

async fn search_vault(root: &Path, query: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    // Do not stop after an arbitrary global number of conversation hits: that
    // used to prevent notes and riffs from being searched at all for broad
    // queries. The timeline is already sorted and decides what is visible, so
    // return every matching id and let it preserve the correct ordering.
    for (dir, kind) in [
        ("conversations", "conversation"),
        ("notes", "note"),
        ("riffs", "riff"),
    ] {
        scan_dir(&root.join(dir), dir, kind, query, &mut hits).await;
    }
    hits.sort_by(|a, b| b.modified.cmp(&a.modified));
    hits
}

async fn scan_dir(dir: &Path, rel_dir: &str, kind: &str, query: &str, hits: &mut Vec<SearchHit>) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return; // Missing directory (no riffs yet, etc.) is not an error.
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
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
        // Conversation metadata (role, timestamp, model, title) isn't message
        // text. Search only content scalars so a query such as "user" doesn't
        // match every user-role record and the returned snippet is meaningful.
        let snippet = if kind == "conversation" {
            first_conversation_content_match(&content, query)
        } else {
            first_match_snippet(&content, query)
        };
        let Some(snippet) = snippet else {
            continue;
        };

        let (id, title) = if kind == "conversation" {
            let stem = name.trim_end_matches(".yaml").to_string();
            (
                yaml_field(&content, "id").unwrap_or_else(|| stem.clone()),
                yaml_field(&content, "title").unwrap_or(stem),
            )
        } else {
            let path = if rel_dir == "riffs" {
                format!("riffs/{name}")
            } else {
                name.clone()
            };
            (path, name.trim_end_matches(".md").to_string())
        };

        let modified = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        hits.push(SearchHit {
            kind: kind.to_string(),
            id,
            title,
            snippet,
            modified,
        });
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

/// Find a query only inside conversation message `content` values, excluding
/// YAML metadata such as `role: user` and returning a clean human snippet rather
/// than serialization syntax such as `content: |-`.
fn first_conversation_content_match(content: &str, query: &str) -> Option<String> {
    let mut in_messages = false;
    let mut block_indent: Option<usize> = None;

    for line in content.lines() {
        if !in_messages {
            if line.trim() == "messages:" {
                in_messages = true;
            }
            continue;
        }

        let indent = line.len() - line.trim_start().len();
        if let Some(content_indent) = block_indent {
            if line.trim().is_empty() {
                continue;
            }
            if indent > content_indent {
                if let Some(snippet) = match_snippet(line.trim(), query) {
                    return Some(snippet);
                }
                continue;
            }
            block_indent = None;
        }

        let trimmed = line.trim_start();
        // Compact YAML may put the first field directly on the sequence marker
        // (`- content: text`) while normal persisted messages use an indented
        // `content:` field after `- id:`.
        let field = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        let Some(value) = field.strip_prefix("content:") else {
            continue;
        };
        let value = value.trim();
        if value.starts_with('|') || value.starts_with('>') {
            block_indent = Some(indent);
            continue;
        }
        let display = value.trim_matches('"').trim_matches('\'');
        if let Some(snippet) = match_snippet(display, query) {
            return Some(snippet);
        }
    }
    None
}

/// First line containing `query` (already lowercased), as a context snippet.
fn first_match_snippet(content: &str, query: &str) -> Option<String> {
    content.lines().find_map(|line| match_snippet(line, query))
}

fn match_snippet(line: &str, query: &str) -> Option<String> {
    let lower = line.to_lowercase();
    let idx = lower.find(query)?;
    // `idx` indexes the lowercased line; map it back to a safe boundary in the
    // original, since lowercasing can change byte lengths.
    let safe = nearest_char_boundary(line, idx.min(line.len()), false);
    Some(snippet_around(line, safe, query.len()))
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
        assert_eq!(
            yaml_field(yaml, "id").as_deref(),
            Some("2024-01-15-1000-aa01")
        );
        assert_eq!(
            yaml_field(yaml, "title").as_deref(),
            Some("Welcome to Alloy")
        );
    }

    #[test]
    fn stops_at_the_message_body() {
        // A `title:` inside a message must not be mistaken for the header field.
        let yaml = "id: x\nmessages:\n- content: |\n    title: fake\n";
        assert_eq!(yaml_field(yaml, "title"), None);
    }

    #[test]
    fn matches_case_insensitively_and_returns_context() {
        let snippet =
            first_match_snippet("The Cost of Context is high", "cost of context").unwrap();
        assert!(snippet.contains("Cost of Context"), "got {snippet}");
    }

    #[test]
    fn reports_no_match_rather_than_an_empty_snippet() {
        assert!(first_match_snippet("nothing relevant here", "kanji").is_none());
    }

    /// Scan a throwaway vault end to end, exercising the real directory walk
    /// rather than just the string helpers.
    async fn scan(dir: &Path, kind: &str, query: &str) -> Vec<SearchHit> {
        let mut hits = Vec::new();
        scan_dir(
            dir,
            if kind == "conversation" {
                "conversations"
            } else {
                "notes"
            },
            kind,
            query,
            &mut hits,
        )
        .await;
        hits
    }

    struct TempVault(std::path::PathBuf);
    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn temp_vault(name: &str) -> TempVault {
        let dir = std::env::temp_dir().join(format!("alloy-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("conversations")).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        TempVault(dir)
    }

    #[tokio::test]
    async fn finds_text_inside_a_conversation_body() {
        // The whole point: this text appears nowhere in the title or filename,
        // which is all the client could match on.
        let v = temp_vault("body");
        std::fs::write(
            v.0.join("conversations/2024-03-03-0900-dd04-trip.yaml"),
            "id: 2024-03-03-0900-dd04\ntitle: Trip notes\nmessages:\n- content: the funicular was closed\n",
        )
        .unwrap();

        let hits = scan(&v.0.join("conversations"), "conversation", "funicular").await;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "2024-03-03-0900-dd04");
        assert_eq!(hits[0].title, "Trip notes");
        assert!(
            hits[0].snippet.contains("funicular"),
            "got {}",
            hits[0].snippet
        );
    }

    #[test]
    fn conversation_search_ignores_metadata_and_cleans_yaml_syntax() {
        let yaml = "id: user-guide\ntitle: User guide\nmessages:\n- role: user\n  content: direct needle text\n- role: assistant\n  content: |-\n    block needle text\n";
        assert!(first_conversation_content_match(yaml, "user").is_none());
        assert_eq!(
            first_conversation_content_match(yaml, "direct").as_deref(),
            Some("direct needle text")
        );
        assert_eq!(
            first_conversation_content_match(yaml, "block").as_deref(),
            Some("block needle text")
        );
    }

    #[tokio::test]
    async fn broad_conversation_matches_do_not_starve_notes() {
        let v = temp_vault("note-starvation");
        // Regression: a global 300-hit early exit scanned conversations first,
        // then skipped notes and riffs entirely.
        for i in 0..300 {
            std::fs::write(
                v.0.join(format!("conversations/c{i}.yaml")),
                format!("id: c{i}\ntitle: C {i}\nmessages:\n- content: common needle\n"),
            )
            .unwrap();
        }
        std::fs::write(v.0.join("notes/Important.md"), "common needle in a note").unwrap();

        let hits = search_vault(&v.0, "common needle").await;
        assert_eq!(hits.len(), 301);
        assert!(hits
            .iter()
            .any(|hit| hit.kind == "note" && hit.id == "Important.md"));
    }

    #[tokio::test]
    async fn ignores_generated_markdown_previews_beside_conversations() {
        // conversations/ also holds .md previews; matching both would report the
        // same conversation twice.
        let v = temp_vault("dupes");
        std::fs::write(
            v.0.join("conversations/c.yaml"),
            "id: c\ntitle: C\nmessages:\n- content: funicular\n",
        )
        .unwrap();
        std::fs::write(v.0.join("conversations/c.md"), "funicular").unwrap();

        assert_eq!(
            scan(&v.0.join("conversations"), "conversation", "funicular")
                .await
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn returns_notes_by_path_so_the_sidebar_can_match_them() {
        let v = temp_vault("notes");
        std::fs::write(
            v.0.join("notes/Project ideas.md"),
            "a thought about funicular railways",
        )
        .unwrap();

        let hits = scan(&v.0.join("notes"), "note", "funicular").await;
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].id, "Project ideas.md",
            "id must match NoteInfo.filename"
        );
    }

    #[tokio::test]
    async fn labels_riffs_separately_from_notes() {
        let v = temp_vault("riffs");
        std::fs::create_dir_all(v.0.join("riffs")).unwrap();
        std::fs::write(v.0.join("riffs/Draft.md"), "a funicular draft").unwrap();

        let hits = search_vault(&v.0, "funicular").await;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "riff");
        assert_eq!(hits[0].id, "riffs/Draft.md");
    }

    #[tokio::test]
    async fn a_missing_directory_is_not_an_error() {
        // A vault with no riffs/ yet must not fail the whole search.
        let v = temp_vault("missing");
        assert!(scan(&v.0.join("riffs"), "note", "anything")
            .await
            .is_empty());
    }

    #[test]
    fn handles_multibyte_content_without_panicking() {
        // Lowercasing can change byte lengths, so the match index has to be
        // mapped back to a char boundary before slicing.
        let snippet = first_match_snippet("消火器 means FIRE EXTINGUISHER here", "fire").unwrap();
        assert!(snippet.contains("FIRE"), "got {snippet}");
    }
}
