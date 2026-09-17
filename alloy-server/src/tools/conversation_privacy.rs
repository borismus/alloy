//! Conversations that carry private-mount material.
//!
//! `private/` mounts are local-only, but every turn is persisted to
//! `conversations/` — an ordinary vault directory any model may read. So a local
//! model's reading of a private note becomes a cloud-readable copy the moment it
//! is discussed. Observed on 2026-09-16: a cloud model could not open
//! `private/obsidian_vault/Sarah relationship log.md`, so it searched
//! `conversations/`, read what a local model had written the day before, and
//! reconstructed the note's path, title, and themes. The mount ACL held;
//! persistence laundered around it.
//!
//! A turn that reads a local-only mount marks its conversation `private: true`,
//! and marked conversations are invisible to cloud callers. Hiding has to cover
//! reads, searches, *and* listings: snippets return content, and conversation
//! filenames are slugs of their titles, so a bare listing leaks the subject of
//! every private conversation without opening one.

use std::path::{Path, PathBuf};

/// Top-level key set on a conversation that contains private-mount material.
pub const MARKER_KEY: &str = "private";

/// Bytes read when testing for the marker. The header (`id`, `title`, `model`,
/// `created`, `updated`, `private`) precedes `messages:`, so the marker is
/// always within the first few hundred bytes of a conversation file.
const HEAD_BYTES: usize = 2048;

/// True when `request_path` addresses the vault's conversation records — the
/// directory itself as well as files inside it, since listing the bare directory
/// is one of the leaks being closed.
pub fn is_conversation_path(request_path: &str) -> bool {
    let rel = request_path.trim_start_matches('/').replace('\\', "/");
    let rel = rel.trim_end_matches('/');
    rel == "conversations" || rel.starts_with("conversations/")
}

/// The YAML record for a conversation file: itself, or the sibling of a
/// Markdown twin. The twin is generated from the record, so the record's marker
/// governs both.
fn record_for(path: &Path) -> PathBuf {
    match path.extension().and_then(|e| e.to_str()) {
        Some("yaml") | Some("yml") => path.to_path_buf(),
        _ => path.with_extension("yaml"),
    }
}

/// True when this conversation is marked as carrying private-mount material.
///
/// Matches the marker only as a top-level key at column zero. Message content is
/// always indented under `messages:`, and YAML block scalars must be indented
/// further than their key, so no message can forge the marker — and a forgery
/// would fail closed anyway, hiding a conversation rather than exposing one.
///
/// Deliberately does *not* stop at `messages:`. YAML permits a top-level key
/// after the sequence, and serde honours it, so a hand-edited file could be
/// genuinely marked below that line; stopping early would read it as unmarked
/// and hand it to a cloud model. Everything that writes the marker puts it in
/// the header, which keeps it inside the bytes read here.
pub fn is_marked_private(path: &Path) -> bool {
    let record = record_for(path);
    let Ok(bytes) = read_head(&record) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return false;
    };
    let marker = format!("{MARKER_KEY}: true");
    text.lines().any(|line| line.trim_end() == marker)
}

fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0u8; HEAD_BYTES];
    let n = file.read(&mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

/// Absolute paths under `dir` that a cloud caller must not see: every marked
/// conversation record and its Markdown twin.
///
/// Returned as exclusion roots so listing and search reuse the same filtering
/// the mounts already use. Only marked conversations land here, so the list
/// stays short even in a large vault.
pub async fn hidden_paths(dir: &Path) -> Vec<PathBuf> {
    let mut hidden = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return hidden;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
            continue;
        }
        if is_marked_private(&path) {
            hidden.push(path.with_extension("md"));
            hidden.push(path);
        }
    }
    hidden
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "alloy-convpriv-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            TempDir(p.canonicalize().unwrap())
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_conversation(dir: &Path, stem: &str, marked: bool, body: &str) -> PathBuf {
        let marker = if marked { "private: true\n" } else { "" };
        let yaml = format!(
            "id: {stem}\ntitle: A conversation\nmodel: mlx/local\ncreated: t\nupdated: t\n{marker}messages:\n- role: user\n  content: |-\n    {body}\n"
        );
        let path = dir.join(format!("{stem}.yaml"));
        fs::write(&path, yaml).unwrap();
        fs::write(dir.join(format!("{stem}.md")), format!("# A conversation\n\n{body}\n")).unwrap();
        path
    }

    #[test]
    fn detects_the_marker_and_its_absence() {
        let d = TempDir::new("marker");
        let marked = write_conversation(&d.0, "marked", true, "hello");
        let plain = write_conversation(&d.0, "plain", false, "hello");
        assert!(is_marked_private(&marked));
        assert!(!is_marked_private(&plain));
    }

    #[test]
    fn the_markdown_twin_inherits_the_records_marker() {
        // The twin has no frontmatter of its own; hiding it has to follow the
        // record, or the same content stays readable one extension away.
        let d = TempDir::new("twin");
        write_conversation(&d.0, "marked", true, "hello");
        assert!(is_marked_private(&d.0.join("marked.md")));
        write_conversation(&d.0, "plain", false, "hello");
        assert!(!is_marked_private(&d.0.join("plain.md")));
    }

    #[test]
    fn message_content_cannot_forge_the_marker() {
        // Message content is indented under `messages:`, and the marker only
        // counts at column zero, so quoting it in a conversation does nothing.
        let d = TempDir::new("forge");
        let path = write_conversation(&d.0, "forged", false, "private: true");
        assert!(!is_marked_private(&path));
    }

    #[test]
    fn a_marker_below_the_messages_block_still_counts() {
        // YAML allows a top-level key after the sequence and serde honours it,
        // so a hand-edited file can be marked there. Reading that as unmarked
        // would hand a private conversation to a cloud model — the one direction
        // this check must never fail in.
        let d = TempDir::new("below");
        let path = d.0.join("below.yaml");
        fs::write(
            &path,
            "id: below\nmodel: mlx/local\ncreated: t\nupdated: t\nmessages:\n- role: user\n  content: hi\nprivate: true\n",
        )
        .unwrap();
        assert!(is_marked_private(&path));
    }

    #[tokio::test]
    async fn hidden_paths_covers_both_files_of_each_marked_conversation() {
        let d = TempDir::new("hidden");
        write_conversation(&d.0, "marked", true, "secret");
        write_conversation(&d.0, "plain", false, "ordinary");

        let hidden = hidden_paths(&d.0).await;
        assert!(hidden.contains(&d.0.join("marked.yaml")), "{hidden:?}");
        assert!(hidden.contains(&d.0.join("marked.md")), "{hidden:?}");
        assert!(!hidden.contains(&d.0.join("plain.yaml")), "{hidden:?}");
        assert!(!hidden.contains(&d.0.join("plain.md")), "{hidden:?}");
    }

    #[test]
    fn recognizes_conversation_request_paths() {
        assert!(is_conversation_path("conversations/x.md"));
        assert!(is_conversation_path("/conversations/x.yaml"));
        // The bare directory matters most: listing it leaks every title slug,
        // and missing this case left listings unfiltered.
        assert!(is_conversation_path("conversations"));
        assert!(is_conversation_path("conversations/"));
        assert!(!is_conversation_path("notes/x.md"));
        assert!(!is_conversation_path("private/obsidian_vault/x.md"));
        assert!(!is_conversation_path("conversations-archive/x.md"));
    }
}
