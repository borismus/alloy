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

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/// Error text the file tools return when a read is refused. Mirrored here so a
/// denial is never mistaken for a successful read; `denial_strings_match_the_tools`
/// keeps this list honest against the tools themselves.
const DENIALS: &[&str] = &[
    "File not found",
    "Directory not found",
    "not accessible",
    "Access denied",
];

/// True when a persisted tool result represents a refusal rather than content.
pub fn is_denial(result: &str) -> bool {
    DENIALS.iter().any(|d| result.starts_with(d))
}

/// One conversation that holds private-mount material but is not yet marked.
#[derive(Debug)]
pub struct Candidate {
    pub path: PathBuf,
    /// Successful local-only mount reads found in its persisted tool history.
    pub reads: usize,
    /// First such target, for the operator to eyeball before writing.
    pub example: String,
}

#[derive(Debug, Default)]
pub struct Report {
    pub scanned: usize,
    pub already_marked: usize,
    /// Touched a `private/` path but was refused every time — nothing private
    /// landed in the file, so marking it would hide a conversation for no reason.
    pub denied_only: usize,
    pub candidates: Vec<Candidate>,
    pub unreadable: Vec<PathBuf>,
}

/// Count successful local-only mount reads persisted in one conversation.
fn private_reads(doc: &serde_yaml::Value) -> (usize, Option<String>) {
    let mut count = 0;
    let mut first = None;
    let Some(messages) = doc.get("messages").and_then(|m| m.as_sequence()) else {
        return (0, None);
    };
    for message in messages {
        let Some(uses) = message.get("toolUse").and_then(|t| t.as_sequence()) else {
            continue;
        };
        for use_ in uses {
            let input = use_.get("input");
            let target = input
                .and_then(|i| i.get("path").or_else(|| i.get("directory")))
                .and_then(|p| p.as_str())
                .unwrap_or("");
            if !target.trim_start_matches('/').starts_with(MOUNT_PREFIX_PRIVATE) {
                continue;
            }
            if use_.get("isError").and_then(|e| e.as_bool()).unwrap_or(false) {
                continue;
            }
            let result = use_.get("result").and_then(|r| r.as_str()).unwrap_or("");
            if is_denial(result) {
                continue;
            }
            count += 1;
            if first.is_none() {
                first = Some(target.to_string());
            }
        }
    }
    (count, first)
}

/// `private/`, duplicated from `mounts` to keep this module free of a cycle.
const MOUNT_PREFIX_PRIVATE: &str = "private/";

/// Examine every conversation record without writing anything.
pub fn scan(conversations_dir: &Path) -> Report {
    let mut report = Report::default();
    let Ok(entries) = std::fs::read_dir(conversations_dir) else {
        return report;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
        .collect();
    paths.sort();

    for path in paths {
        report.scanned += 1;
        let Ok(text) = std::fs::read_to_string(&path) else {
            report.unreadable.push(path);
            continue;
        };
        if is_marked_private(&path) {
            report.already_marked += 1;
            continue;
        }
        let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
            report.unreadable.push(path);
            continue;
        };
        let (reads, example) = private_reads(&doc);
        if reads > 0 {
            report.candidates.push(Candidate {
                path,
                reads,
                example: example.unwrap_or_default(),
            });
        } else if text.contains("private/") {
            report.denied_only += 1;
        }
    }
    report
}

/// Insert the marker immediately before the top-level `messages:` key.
///
/// Textual on purpose. Re-serializing the YAML would rewrite quoting, ordering,
/// and line wrapping across files the user reads in Obsidian, and would rewrite
/// message bodies this command has no business touching. Returns `None` when the
/// shape isn't what we expect, so an odd file is skipped rather than guessed at.
pub fn insert_marker(original: &str) -> Option<String> {
    if original.lines().any(|l| l.trim_end() == format!("{MARKER_KEY}: true")) {
        return None; // already marked
    }
    let idx = original
        .lines()
        .position(|line| line.starts_with("messages:"))?;
    let mut out = String::with_capacity(original.len() + 16);
    for (i, line) in original.lines().enumerate() {
        if i == idx {
            out.push_str(&format!("{MARKER_KEY}: true\n"));
        }
        out.push_str(line);
        out.push('\n');
    }
    // The file must be byte-identical apart from the one inserted line. This is
    // the whole safety property of the migration, so it is checked rather than
    // trusted — and the trailing-newline normalisation above is exactly the kind
    // of drift it catches.
    if out.replacen(&format!("{MARKER_KEY}: true\n"), "", 1) != original {
        return None;
    }
    Some(out)
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
    fn insert_marker_adds_exactly_one_line_and_changes_nothing_else() {
        let original = "id: x\ntitle: A thing\nmodel: mlx/local\ncreated: t\nupdated: t\nmessages:\n- role: user\n  content: |-\n    hello\n";
        let updated = insert_marker(original).unwrap();
        assert_eq!(updated.replacen("private: true\n", "", 1), original);
        assert_eq!(updated.lines().count(), original.lines().count() + 1);
        // Header placement, ahead of messages, where the short read looks.
        assert!(updated.find("private: true").unwrap() < updated.find("messages:").unwrap());
        // `updated:` is untouched, so the sidebar does not reshuffle.
        assert!(updated.contains("updated: t\n"));
    }

    #[test]
    fn insert_marker_declines_rather_than_guessing() {
        // Already marked.
        assert!(insert_marker("id: x\nprivate: true\nmessages:\n- a\n").is_none());
        // No top-level messages key: not a shape we understand, so leave it be.
        assert!(insert_marker("id: x\nupdated: t\n").is_none());
        // Indented `messages:` belongs to something else.
        assert!(insert_marker("id: x\nnested:\n  messages:\n  - a\n").is_none());
    }

    #[test]
    fn scan_marks_successful_reads_and_leaves_refusals_alone() {
        let d = TempDir::new("scan");
        let write = |name: &str, body: &str| {
            fs::write(d.0.join(name), body).unwrap();
        };
        // A local model that actually read the mount.
        write(
            "read.yaml",
            "id: r\nmodel: mlx/x\nupdated: t\nmessages:\n- role: assistant\n  toolUse:\n  - type: read_file\n    input:\n      path: private/obsidian_vault/Diary.md\n    result: 'dear diary'\n",
        );
        // A cloud model that was refused: nothing private landed in the file.
        write(
            "denied.yaml",
            "id: d\nmodel: codex-cli/x\nupdated: t\nmessages:\n- role: assistant\n  toolUse:\n  - type: read_file\n    input:\n      path: private/obsidian_vault/Diary.md\n    result: 'File not found: private/obsidian_vault/Diary.md'\n",
        );
        // Ordinary conversation.
        write(
            "plain.yaml",
            "id: p\nmodel: mlx/x\nupdated: t\nmessages:\n- role: user\n  content: hi\n",
        );
        // Already marked: must not be counted again.
        write(
            "done.yaml",
            "id: done\nmodel: mlx/x\nupdated: t\nprivate: true\nmessages:\n- role: assistant\n  toolUse:\n  - type: read_file\n    input:\n      path: private/obsidian_vault/D.md\n    result: 'x'\n",
        );

        let report = scan(&d.0);
        assert_eq!(report.scanned, 4);
        assert_eq!(report.already_marked, 1);
        assert_eq!(report.denied_only, 1);
        let names: Vec<_> = report
            .candidates
            .iter()
            .map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["read.yaml"], "only the file holding content");
        assert_eq!(report.candidates[0].reads, 1);
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
