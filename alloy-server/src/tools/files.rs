//! File tools: `read_file`, `write_file`, `append_to_note`, `list_directory`.
//!
//! Permission model mirrors [src/services/tools/builtin/files.ts](src/services/tools/builtin/files.ts):
//! - notes/ — read+write (no approval needed)
//! - skills/ — read+write client-side, but **write requires approval which
//!   we don't ship in Phase 1** → server-mode hard-errors writes to skills/
//! - conversations/ — read only
//! - triggers/ — same as skills/ (read; write requires approval → server hard-error)
//! - root files: read allowed; write allowed only for memory.md (other root
//!   writes require approval → hard-error)

use serde_json::{Value, json};
use tokio::fs;

use crate::tools::{ToolContext, ToolRegistry, input_string};

#[derive(Copy, Clone, PartialEq)]
enum Op {
    Read,
    Write,
}

/// Returns Some(error_message) if the operation is denied; None if allowed.
fn check_permission(path: &str, op: Op) -> Option<String> {
    let normalized = path.replace('\\', "/");

    // Path traversal — defense in depth on top of Vault::resolve.
    if normalized.contains("..") || normalized.starts_with('/') {
        return Some("Invalid path: must be relative and cannot contain \"..\"".into());
    }

    let dir_segments: &[(&str, bool, bool)] = &[
        // (prefix, read, write_in_server_mode)
        ("notes/", true, true),
        ("skills/", true, false), // writes would need approval → blocked
        ("conversations/", true, false), // read-only
        ("triggers/", true, false), // writes would need approval → blocked
    ];

    if normalized.contains('/') {
        for (prefix, can_read, can_write) in dir_segments {
            if normalized.starts_with(prefix) {
                let allowed = match op {
                    Op::Read => *can_read,
                    Op::Write => *can_write,
                };
                if allowed {
                    return None;
                }
                return Some(match op {
                    Op::Read => format!("Access denied: read permission not allowed for path \"{}\"", path),
                    Op::Write => format!(
                        "Access denied: write to \"{}\" requires user approval, which isn't supported in server mode (Phase 1). Use the desktop app, or write to notes/ or memory.md.",
                        path
                    ),
                });
            }
        }
        // Unlisted nested directory.
        return Some(format!("Access denied: \"{}\" is not in an allowed vault directory", path));
    }

    // Root-level file
    match op {
        Op::Read => None,
        Op::Write => {
            if normalized == "memory.md" {
                None
            } else {
                Some(format!(
                    "Access denied: write to root file \"{}\" requires user approval, which isn't supported in server mode (Phase 1). Allowed: memory.md.",
                    path
                ))
            }
        }
    }
}

pub async fn execute_read(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let path = input_string(input, "path").unwrap_or("").trim();
    if path.is_empty() {
        return Err("Missing required parameter: path".into());
    }
    if let Some(msg) = check_permission(path, Op::Read) {
        return Err(msg);
    }
    let resolved = registry.vault.resolve(path).map_err(|e| e.to_string())?;
    fs::read_to_string(&resolved)
        .await
        .map_err(|_| format!("File not found: {}", path))
}

pub async fn execute_write(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let path = input_string(input, "path").unwrap_or("").trim();
    let content = input_string(input, "content").unwrap_or("");
    if path.is_empty() {
        return Err("Missing required parameter: path".into());
    }
    if let Some(msg) = check_permission(path, Op::Write) {
        return Err(msg);
    }
    let resolved = registry.vault.resolve(path).map_err(|e| e.to_string())?;
    if let Some(parent) = resolved.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    fs::write(&resolved, content.as_bytes())
        .await
        .map_err(|e| format!("Error writing file: {}", e))?;
    Ok(format!("Successfully wrote to {}", path))
}

pub async fn execute_append_to_note(
    registry: &ToolRegistry,
    ctx: &ToolContext,
    input: &Value,
) -> Result<String, String> {
    let path = input_string(input, "path").unwrap_or("").trim();
    let content = input_string(input, "content").unwrap_or("");
    if path.is_empty() {
        return Err("Missing required parameter: path".into());
    }
    if let Some(msg) = check_permission(path, Op::Write) {
        return Err(msg);
    }
    let resolved = registry.vault.resolve(path).map_err(|e| e.to_string())?;

    // Provenance: link each non-empty line back to the conversation+message
    // that produced it, matching the SPA's `&[[convId^msgId]]` marker format.
    let conv_id = ctx
        .conversation_id
        .clone()
        .unwrap_or_else(|| "unknown".into());
    let msg_id = ctx
        .message_id
        .clone()
        .unwrap_or_else(|| format!("msg-{}", chrono::Utc::now().timestamp_millis()));
    let provenance = format!("&[[{}^{}]]", conv_id, msg_id);

    let appended: Vec<String> = content
        .lines()
        .map(|line| {
            if line.trim().is_empty() {
                line.to_string()
            } else {
                format!("{} {}", line, provenance)
            }
        })
        .collect();
    let new_block = appended.join("\n");

    let existing = fs::read_to_string(&resolved).await.unwrap_or_default();
    let merged = if existing.is_empty() {
        new_block
    } else {
        format!("{}\n\n{}", existing.trim_end(), new_block)
    };

    if let Some(parent) = resolved.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    fs::write(&resolved, merged.as_bytes())
        .await
        .map_err(|e| format!("Error appending to note: {}", e))?;
    Ok(format!("Appended to {}", path))
}

pub async fn execute_list_directory(
    registry: &ToolRegistry,
    input: &Value,
) -> Result<String, String> {
    let path = input_string(input, "path").unwrap_or("").trim();
    if path.is_empty() {
        return Err("Missing required parameter: path".into());
    }
    if let Some(msg) = check_permission(path, Op::Read) {
        return Err(msg);
    }
    let resolved = registry.vault.resolve(path).map_err(|e| e.to_string())?;
    let mut entries = fs::read_dir(&resolved)
        .await
        .map_err(|_| format!("Directory not found: {}", path))?;

    #[derive(serde::Serialize)]
    struct Entry {
        name: String,
        #[serde(rename = "isDirectory")]
        is_directory: bool,
    }

    let mut out: Vec<Entry> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Error listing directory: {}", e))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(t) => t,
            Err(_) => continue,
        };
        out.push(Entry {
            name,
            is_directory: file_type.is_dir(),
        });
    }
    out.sort_by(|a, b| {
        // Directories first, then alphabetical.
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(serde_json::to_string_pretty(&json!({
        "directory": path,
        "files": out,
    }))
    .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_root_memory_md_writable() {
        assert!(check_permission("memory.md", Op::Write).is_none());
    }

    #[test]
    fn permission_root_other_writes_blocked() {
        assert!(check_permission("config.yaml", Op::Write).is_some());
    }

    #[test]
    fn permission_notes_writable() {
        assert!(check_permission("notes/foo.md", Op::Write).is_none());
        assert!(check_permission("notes/nested/bar.md", Op::Write).is_none());
    }

    #[test]
    fn permission_skills_write_blocked() {
        let r = check_permission("skills/my-skill/SKILL.md", Op::Write);
        assert!(r.is_some());
        assert!(r.unwrap().contains("requires user approval"));
    }

    #[test]
    fn permission_skills_readable() {
        assert!(check_permission("skills/my-skill/SKILL.md", Op::Read).is_none());
    }

    #[test]
    fn permission_conversations_read_only() {
        assert!(check_permission("conversations/foo.yaml", Op::Read).is_none());
        assert!(check_permission("conversations/foo.yaml", Op::Write).is_some());
    }

    #[test]
    fn permission_traversal_blocked() {
        assert!(check_permission("../outside.md", Op::Read).is_some());
        assert!(check_permission("notes/../outside.md", Op::Read).is_some());
        assert!(check_permission("/etc/passwd", Op::Read).is_some());
    }
}
