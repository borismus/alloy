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

use crate::tools::{ToolContext, ToolRegistry, input_bool, input_string, input_usize};

/// Cap on `read_file` output so a huge file (e.g. a big conversation YAML)
/// can't blow the model's context in one call.
const MAX_READ_BYTES: usize = 64 * 1024;

const LIST_DEFAULT_LIMIT: usize = 100;
const LIST_MAX_LIMIT: usize = 200;
const LIST_MAX_DEPTH: usize = 6;
const LIST_MAX_SCANNED: usize = 20_000;

/// ISO-8601 (RFC 3339, seconds) UTC string for a file mtime.
fn iso(t: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Truncate an over-large file read at a char boundary, appending a marker.
fn cap_read(content: String) -> String {
    if content.len() <= MAX_READ_BYTES {
        return content;
    }
    let mut end = MAX_READ_BYTES;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[truncated: file is {} bytes; showing the first {} KB]",
        &content[..end],
        content.len(),
        MAX_READ_BYTES / 1024
    )
}

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

pub async fn execute_read(
    registry: &ToolRegistry,
    ctx: &ToolContext,
    input: &Value,
) -> Result<String, String> {
    let path = input_string(input, "path").unwrap_or("").trim();
    if path.is_empty() {
        return Err("Missing required parameter: path".into());
    }
    // Private mount: readable by local models only. Cloud models get a generic
    // "not found" without touching disk, so they can't tell it exists.
    if crate::tools::private::is_private_path(path) {
        let not_found = || format!("File not found: {}", path);
        if !ctx.model_is_local {
            return Err(not_found());
        }
        return match crate::tools::private::resolve_private_path(&registry.config, path) {
            Ok(Some(abs)) => fs::read_to_string(&abs).await.map(cap_read).map_err(|_| not_found()),
            _ => Err(not_found()),
        };
    }
    if let Some(msg) = check_permission(path, Op::Read) {
        return Err(msg);
    }
    let resolved = registry.vault.resolve(path).map_err(|e| e.to_string())?;
    fs::read_to_string(&resolved)
        .await
        .map(cap_read)
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

struct ListOpts {
    limit: usize,
    offset: usize,
    recursive: bool,
    /// Most-recent-first (default) vs. dirs-first-alphabetical (`sort=name`).
    by_recent: bool,
}

pub async fn execute_list_directory(
    registry: &ToolRegistry,
    ctx: &ToolContext,
    input: &Value,
) -> Result<String, String> {
    let path = input_string(input, "path").unwrap_or("").trim();
    if path.is_empty() {
        return Err("Missing required parameter: path".into());
    }
    let opts = ListOpts {
        limit: input_usize(input, "limit")
            .unwrap_or(LIST_DEFAULT_LIMIT)
            .clamp(1, LIST_MAX_LIMIT),
        offset: input_usize(input, "offset").unwrap_or(0),
        recursive: input_bool(input, "recursive").unwrap_or(false),
        by_recent: input_string(input, "sort").map(|s| s != "name").unwrap_or(true),
    };

    // Private mount: listable by local models only; cloud models get a generic
    // "not found" (never revealing the dir's existence or its host path).
    if crate::tools::private::is_private_path(path) {
        let not_found = || format!("Directory not found: {}", path);
        if !ctx.model_is_local {
            return Err(not_found());
        }
        let abs = match crate::tools::private::resolve_private_path(&registry.config, path) {
            Ok(Some(abs)) => abs,
            _ => return Err(not_found()),
        };
        let excludes = crate::tools::private::private_exclude_roots(&registry.config, path);
        return list_dir_json(&abs, path, &opts, &excludes).await;
    }
    if let Some(msg) = check_permission(path, Op::Read) {
        return Err(msg);
    }
    let resolved = registry.vault.resolve(path).map_err(|e| e.to_string())?;
    list_dir_json(&resolved, path, &opts, &[]).await
}

struct ListEntry {
    /// Path relative to the listed directory (just the name when non-recursive).
    name: String,
    is_directory: bool,
    modified: std::time::SystemTime,
}

/// List `dir` (optionally recursively), drop dotfiles and anything under
/// `excludes`, then sort + paginate into `{ directory, total, offset, returned,
/// nextOffset?, files: [{ name, isDirectory, modified }] }`. `label` is the
/// path echoed back to the model (vault-relative or `private/<alias>/` — never
/// the host path). Only the *output* is capped by `limit`; the listing itself
/// is complete (names + mtime only, no content reads).
async fn list_dir_json(
    dir: &std::path::Path,
    label: &str,
    opts: &ListOpts,
    excludes: &[std::path::PathBuf],
) -> Result<String, String> {
    let mut out: Vec<ListEntry> = Vec::new();
    let mut scanned = 0usize;
    let mut root_ok = false;
    // (abs_dir, rel_prefix, depth) — root popped first (LIFO), so a failed root
    // read is distinguishable from a failed subdir read.
    let mut stack: Vec<(std::path::PathBuf, String, usize)> =
        vec![(dir.to_path_buf(), String::new(), 0)];

    while let Some((abs, prefix, depth)) = stack.pop() {
        let mut entries = match fs::read_dir(&abs).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        root_ok = true;
        while scanned < LIST_MAX_SCANNED {
            let entry = match entries.next_entry().await {
                Ok(Some(e)) => e,
                _ => break,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let entry_abs = entry.path();
            if excludes.iter().any(|ex| entry_abs.starts_with(ex)) {
                continue;
            }
            let file_type = match entry.file_type().await {
                Ok(t) => t,
                Err(_) => continue,
            };
            let is_directory = file_type.is_dir();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{}/{}", prefix, name)
            };
            let modified = entry
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH);
            scanned += 1;
            if opts.recursive && is_directory && depth < LIST_MAX_DEPTH {
                stack.push((entry_abs, rel.clone(), depth + 1));
            }
            out.push(ListEntry {
                name: rel,
                is_directory,
                modified,
            });
        }
    }

    if !root_ok {
        return Err(format!("Directory not found: {}", label));
    }

    if opts.by_recent {
        out.sort_by(|a, b| {
            b.modified
                .cmp(&a.modified)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    } else {
        out.sort_by(|a, b| match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }

    let total = out.len();
    let files: Vec<Value> = out
        .iter()
        .skip(opts.offset)
        .take(opts.limit)
        .map(|e| {
            json!({
                "name": e.name,
                "isDirectory": e.is_directory,
                "modified": iso(e.modified),
            })
        })
        .collect();
    let returned = files.len();
    let mut obj = json!({
        "directory": label,
        "total": total,
        "offset": opts.offset,
        "returned": returned,
        "files": files,
    });
    if opts.offset + returned < total {
        obj["nextOffset"] = json!(opts.offset + returned);
    }
    Ok(serde_json::to_string_pretty(&obj).unwrap_or_default())
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

    // A private mount path is never a valid *write* target — check_permission's
    // fallthrough denies it, so no write branch is needed anywhere. Regression
    // guard for that invariant.
    #[test]
    fn permission_private_writes_blocked() {
        assert!(check_permission("private/notes/secret.md", Op::Write).is_some());
        assert!(check_permission("private/notes/secret.md", Op::Read).is_some());
    }

    // ---- private-mount read/list enforcement (local-only) ----
    use std::sync::Arc;

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "alloy-files-test-{}-{}-{}",
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

    /// Build a registry whose vault is `vault_dir` and whose only private mount
    /// is `private/notes -> external_dir`.
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
    async fn private_read_local_allowed_cloud_denied() {
        let vault = TempDir::new("vault-r");
        let external = TempDir::new("ext-r");
        std::fs::write(external.0.join("diary.md"), "dear diary").unwrap();
        let reg = registry_with_private(&vault.0, &external.0);
        let input = json!({ "path": "private/notes/diary.md" });

        // Local model reads the external file.
        let ok = execute_read(&reg, &ctx(true), &input).await.unwrap();
        assert_eq!(ok, "dear diary");

        // Cloud model gets a generic not-found — no content, no host path leaked.
        let err = execute_read(&reg, &ctx(false), &input).await.unwrap_err();
        assert!(!err.contains("dear diary"));
        assert!(!err.contains(external.0.to_str().unwrap()));
    }

    #[tokio::test]
    async fn private_list_local_allowed_cloud_denied() {
        let vault = TempDir::new("vault-l");
        let external = TempDir::new("ext-l");
        std::fs::write(external.0.join("a.md"), "x").unwrap();
        let reg = registry_with_private(&vault.0, &external.0);
        let input = json!({ "path": "private/notes" });

        let ok = execute_list_directory(&reg, &ctx(true), &input).await.unwrap();
        assert!(ok.contains("a.md"));
        // Echoes the mount path back, never the real host path.
        assert!(ok.contains("private/notes"));
        assert!(!ok.contains(external.0.to_str().unwrap()));

        let err = execute_list_directory(&reg, &ctx(false), &input)
            .await
            .unwrap_err();
        assert!(!err.contains("a.md"));
    }

    #[tokio::test]
    async fn private_write_denied_even_for_local() {
        let vault = TempDir::new("vault-w");
        let external = TempDir::new("ext-w");
        let reg = registry_with_private(&vault.0, &external.0);
        let input = json!({ "path": "private/notes/new.md", "content": "nope" });
        // write_file has no ctx / no private branch — check_permission rejects it.
        assert!(execute_write(&reg, &input).await.is_err());
        assert!(!external.0.join("new.md").exists());
    }

    #[tokio::test]
    async fn list_paginates_and_reports_total() {
        let vault = TempDir::new("vault-pg");
        let external = TempDir::new("ext-pg");
        for i in 0..5 {
            std::fs::write(external.0.join(format!("n{i}.md")), "x").unwrap();
        }
        let reg = registry_with_private(&vault.0, &external.0);
        let out = execute_list_directory(&reg, &ctx(true), &json!({ "path": "private/notes", "limit": 2 }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["total"], 5);
        assert_eq!(v["returned"], 2);
        assert_eq!(v["nextOffset"], 2);
        assert_eq!(v["files"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn list_recursive_includes_nested_with_relative_path() {
        let vault = TempDir::new("vault-rec");
        let external = TempDir::new("ext-rec");
        std::fs::write(external.0.join("top.md"), "x").unwrap();
        std::fs::create_dir_all(external.0.join("sub")).unwrap();
        std::fs::write(external.0.join("sub").join("deep.md"), "x").unwrap();
        let reg = registry_with_private(&vault.0, &external.0);
        // Non-recursive: top-level only.
        let shallow = execute_list_directory(&reg, &ctx(true), &json!({ "path": "private/notes" }))
            .await
            .unwrap();
        assert!(shallow.contains("top.md"));
        assert!(!shallow.contains("deep.md"));
        // Recursive: nested file appears with its relative subpath.
        let deep = execute_list_directory(&reg, &ctx(true), &json!({ "path": "private/notes", "recursive": true }))
            .await
            .unwrap();
        assert!(deep.contains("sub/deep.md"));
    }

    #[tokio::test]
    async fn private_exclude_dirs_skips_subtree() {
        use crate::config::{Config, PrivateDir};
        use crate::providers::ProviderRegistry;
        use crate::skill_registry::SkillRegistry;
        use crate::vault::Vault;

        let vault = TempDir::new("vault-ex");
        let external = TempDir::new("ext-ex");
        std::fs::write(external.0.join("keep.md"), "x").unwrap();
        std::fs::create_dir_all(external.0.join("PromptBox")).unwrap();
        std::fs::write(external.0.join("PromptBox").join("hidden.md"), "x").unwrap();

        let config = Config {
            private_read_only_dirs: vec![PrivateDir {
                alias: "notes".into(),
                path: external.0.clone(),
                exclude_dirs: vec!["PromptBox".into()],
                description: None,
            }],
            ..Config::default()
        };
        let reg = Arc::new(ToolRegistry::new(
            Arc::new(config),
            Arc::new(Vault::new(vault.0.clone()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ));
        let out = execute_list_directory(&reg, &ctx(true), &json!({ "path": "private/notes", "recursive": true }))
            .await
            .unwrap();
        assert!(out.contains("keep.md"));
        assert!(!out.contains("hidden.md"));
        assert!(!out.contains("PromptBox"));
    }
}
