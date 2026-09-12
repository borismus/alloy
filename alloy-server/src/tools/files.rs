//! File tools: `read_file`, `write_file`, `append_to_note`, `list_directory`.
//!
//! Permission model mirrors [src/services/tools/builtin/files.ts](src/services/tools/builtin/files.ts):
//! - notes/ — read+write (no approval needed)
//! - skills/ — read+write client-side, but **write requires approval which
//!   we don't ship in Phase 1** → server-mode hard-errors writes to skills/
//! - conversations/ — read only
//! - tasks/ — same as skills/ (read; write requires approval → server hard-error)
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

/// The one file injected into every system prompt. It is hand-curated, has no
/// history in the vault, and a careless model rewrite silently degrades every
/// later turn in every conversation — so it gets protections ordinary notes
/// don't: a rolling backup, an atomic replace, and a refusal to shrink it
/// sharply without having read what it is replacing.
const MEMORY_FILE: &str = "memory.md";
/// Kept at the vault root. Dot-prefixed deliberately: `read_file` rejects
/// unlisted nested directories, while `list_directory`, `search_directory`,
/// vault search, and the file watcher all skip dotfiles — so backups stay out
/// of prompts, search results, and the timeline without extra filtering.
const MEMORY_BACKUP_DIR: &str = ".memory-backups";
const MEMORY_BACKUPS_KEPT: usize = 10;

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
        ("tasks/", true, false), // writes would need approval → blocked
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
    let content = fs::read_to_string(&resolved)
        .await
        .map(cap_read)
        .map_err(|_| format!("File not found: {}", path))?;
    // Remember that this turn has seen the current memory, so a later
    // rewrite can be trusted to be based on it rather than on a guess.
    if path.replace('\\', "/") == MEMORY_FILE {
        ctx.memory_read_this_turn
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(content)
}

/// Decide whether a proposed `memory.md` replacement is safe to apply.
///
/// The failure this prevents is silent and unrecoverable: `save-memory` asks
/// the model to write back the **complete** updated file, so a model that
/// summarises carelessly, or whose generation is cut short, replaces curated
/// memory with less than it had — and the vault keeps no history to restore
/// from. A caller that read the current revision this turn is taken at its
/// word; one that did not must not be able to discard most of the file.
pub(crate) fn review_memory_write(
    current: Option<&str>,
    next: &str,
    saw_current_revision: bool,
) -> Result<(), String> {
    if next.trim().is_empty() {
        return Err(format!(
            "Refused: this would leave {} empty, and it has no history to restore from. \
             If you meant to remove a section, write the full file with just that section \
             removed. To clear it deliberately, edit the file directly.",
            MEMORY_FILE
        ));
    }
    let Some(current) = current.filter(|value| !value.trim().is_empty()) else {
        return Ok(()); // Nothing to lose.
    };

    let had = current.chars().count();
    let kept = next.chars().count();
    // Losing more than half of a curated file is a summarisation accident far
    // more often than an intended edit.
    if kept * 2 < had && !saw_current_revision {
        return Err(format!(
            "Refused: this would cut {} from {} to {} characters, and this turn has not read \
             it, so the shorter text may be missing content you cannot recover. Read {} \
             first, then write the complete updated file.",
            MEMORY_FILE, had, kept, MEMORY_FILE
        ));
    }
    Ok(())
}

/// Replace a file by writing a sibling temp file and renaming it, so a crash or
/// a short write can never leave the original truncated.
async fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    // Dot-prefixed so a leftover temp from a hard kill stays out of listings.
    let temp = path.with_file_name(format!(".{}.tmp-{}", name, uuid::Uuid::new_v4()));
    fs::write(&temp, bytes).await?;
    fs::rename(&temp, path).await
}

/// Keep a timestamped copy of the outgoing `memory.md`, then trim the set.
/// Content is never logged — only sizes and counts.
async fn back_up_memory(registry: &ToolRegistry, current: &str) -> std::io::Result<()> {
    let dir = registry
        .vault
        .resolve(MEMORY_BACKUP_DIR)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    fs::create_dir_all(&dir).await?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    fs::write(dir.join(format!("memory-{stamp}.md")), current.as_bytes()).await?;

    let mut kept: Vec<String> = Vec::new();
    let mut entries = fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("memory-") && name.ends_with(".md") {
            kept.push(name);
        }
    }
    // ISO-8601 stamps sort chronologically as strings.
    kept.sort();
    let excess = kept.len().saturating_sub(MEMORY_BACKUPS_KEPT);
    for name in kept.into_iter().take(excess) {
        let _ = fs::remove_file(dir.join(name)).await;
    }
    Ok(())
}

/// Write `memory.md`: review, back up, then replace atomically.
async fn write_memory(
    registry: &ToolRegistry,
    ctx: &ToolContext,
    resolved: &std::path::Path,
    next: &str,
) -> Result<String, String> {
    let current = fs::read_to_string(resolved).await.ok();
    review_memory_write(
        current.as_deref(),
        next,
        ctx.memory_read_this_turn
            .load(std::sync::atomic::Ordering::Relaxed),
    )?;

    let mut backed_up = false;
    if let Some(previous) = current.as_deref() {
        // An unchanged rewrite is common (the model re-saves identical text);
        // backing it up again would evict a genuinely different older version.
        if previous != next && !previous.trim().is_empty() {
            back_up_memory(registry, previous).await.map_err(|e| {
                format!(
                    "Refused: could not back up the current {} ({}), so it was left unchanged \
                     rather than overwritten without a copy.",
                    MEMORY_FILE, e
                )
            })?;
            backed_up = true;
        }
    }

    write_atomic(resolved, next.as_bytes())
        .await
        .map_err(|e| format!("Error writing file: {}", e))?;
    tracing::info!(
        previous_bytes = current.as_deref().map(str::len).unwrap_or(0),
        new_bytes = next.len(),
        backed_up,
        "memory.md replaced"
    );
    Ok(format!(
        "Successfully wrote to {}{}",
        MEMORY_FILE,
        if backed_up {
            " (previous version kept in the rolling backup set)"
        } else {
            ""
        }
    ))
}

pub async fn execute_write(
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
    // Ordinary notes keep their existing plain-overwrite behaviour; only the
    // one irreplaceable file gets the extra protection.
    if path.replace('\\', "/") == MEMORY_FILE {
        return write_memory(registry, ctx, &resolved, content).await;
    }
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
            execution_policy: crate::execution_policy::ExecutionPolicy::interactive(),
            memory_read_this_turn: Default::default(),
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
        // write_file has no private branch — check_permission rejects it.
        assert!(execute_write(&reg, &ctx(true), &input).await.is_err());
        assert!(!external.0.join("new.md").exists());
    }

    /// Build a registry over a bare vault with an existing memory.md.
    fn memory_registry(vault: &std::path::Path, body: &str) -> Arc<ToolRegistry> {
        use crate::config::Config;
        use crate::providers::ProviderRegistry;
        use crate::skill_registry::SkillRegistry;
        use crate::vault::Vault;

        std::fs::write(vault.join("memory.md"), body).unwrap();
        Arc::new(ToolRegistry::new(
            Arc::new(Config::default()),
            Arc::new(Vault::new(vault.to_path_buf()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ))
    }

    fn backups(vault: &std::path::Path) -> Vec<String> {
        let dir = vault.join(MEMORY_BACKUP_DIR);
        if !dir.exists() {
            return Vec::new();
        }
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().to_string()))
            .collect();
        names.sort();
        names
    }

    /// The exact accident this exists for: `save-memory` asks for the complete
    /// file, so a careless summary silently replaces curated memory with less.
    #[test]
    fn memory_review_blocks_unverified_loss_but_allows_ordinary_edits() {
        let curated = "# Memory\n".to_string() + &"- a curated line\n".repeat(40);

        // Emptying it is never acceptable, read or not.
        assert!(review_memory_write(Some(&curated), "   ", true).is_err());
        assert!(review_memory_write(Some(&curated), "", false).is_err());

        // Dropping most of the file without having read it reads as an accident.
        let error = review_memory_write(Some(&curated), "- one line", false).unwrap_err();
        assert!(error.contains("has not read it"), "{error}");

        // Same write from a caller that did read it is a deliberate edit.
        assert!(review_memory_write(Some(&curated), "- one line", true).is_ok());

        // Ordinary growth and small trims are untouched either way.
        assert!(review_memory_write(Some(&curated), &format!("{curated}- more\n"), false).is_ok());
        let small_trim: String = curated.lines().take(30).collect::<Vec<_>>().join("\n");
        assert!(review_memory_write(Some(&curated), &small_trim, false).is_ok());

        // A first write has nothing to lose.
        assert!(review_memory_write(None, "- first note", false).is_ok());
        assert!(review_memory_write(Some("  "), "- replacing a blank file", false).is_ok());
    }

    #[tokio::test]
    async fn memory_write_keeps_a_recoverable_copy_and_replaces_atomically() {
        let vault = TempDir::new("vault-mem");
        let reg = memory_registry(&vault.0, "# Memory\n- original curated line\n");

        let input = json!({ "path": "memory.md", "content": "# Memory\n- original curated line\n- added\n" });
        let out = execute_write(&reg, &ctx(false), &input).await.unwrap();
        assert!(out.contains("backup"), "{out}");

        assert_eq!(
            std::fs::read_to_string(vault.0.join("memory.md")).unwrap(),
            "# Memory\n- original curated line\n- added\n"
        );
        let saved = backups(&vault.0);
        assert_eq!(saved.len(), 1, "previous version is recoverable");
        assert_eq!(
            std::fs::read_to_string(vault.0.join(MEMORY_BACKUP_DIR).join(&saved[0])).unwrap(),
            "# Memory\n- original curated line\n"
        );

        // No temp file survives a completed write.
        let leftovers: Vec<_> = std::fs::read_dir(&vault.0)
            .unwrap()
            .filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().to_string()))
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[tokio::test]
    async fn a_destructive_memory_write_leaves_the_file_untouched() {
        let vault = TempDir::new("vault-mem2");
        let curated = "# Memory\n".to_string() + &"- a curated line\n".repeat(40);
        let reg = memory_registry(&vault.0, &curated);

        let input = json!({ "path": "memory.md", "content": "- oops" });
        let error = execute_write(&reg, &ctx(false), &input).await.unwrap_err();
        assert!(error.contains("Refused"), "{error}");
        assert_eq!(std::fs::read_to_string(vault.0.join("memory.md")).unwrap(), curated);
        assert!(backups(&vault.0).is_empty(), "a refused write backs up nothing");

        // Reading it first makes the same write a deliberate edit.
        let context = ctx(false);
        execute_read(&reg, &context, &json!({ "path": "memory.md" })).await.unwrap();
        execute_write(&reg, &context, &input).await.unwrap();
        assert_eq!(std::fs::read_to_string(vault.0.join("memory.md")).unwrap(), "- oops");
        assert_eq!(backups(&vault.0).len(), 1, "and the old version is still recoverable");
    }

    #[tokio::test]
    async fn identical_rewrites_do_not_evict_older_backups() {
        let vault = TempDir::new("vault-mem3");
        let reg = memory_registry(&vault.0, "# Memory\n- one\n");
        let same = json!({ "path": "memory.md", "content": "# Memory\n- one\n" });
        execute_write(&reg, &ctx(false), &same).await.unwrap();
        execute_write(&reg, &ctx(false), &same).await.unwrap();
        assert!(backups(&vault.0).is_empty(), "nothing changed, nothing to keep");
    }

    #[tokio::test]
    async fn the_backup_set_stays_bounded_and_keeps_the_newest() {
        let vault = TempDir::new("vault-mem4");
        let reg = memory_registry(&vault.0, "# Memory\n- v0\n");
        for i in 1..=MEMORY_BACKUPS_KEPT + 4 {
            let input = json!({ "path": "memory.md", "content": format!("# Memory\n- v{i}\n") });
            execute_write(&reg, &ctx(false), &input).await.unwrap();
            // Distinct millisecond stamps.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        let saved = backups(&vault.0);
        assert_eq!(saved.len(), MEMORY_BACKUPS_KEPT);
        let newest = std::fs::read_to_string(
            vault.0.join(MEMORY_BACKUP_DIR).join(saved.last().unwrap()),
        )
        .unwrap();
        assert!(newest.contains(&format!("- v{}", MEMORY_BACKUPS_KEPT + 3)), "{newest}");
    }

    /// Backups must not leak back into prompts, search results, or listings.
    #[tokio::test]
    async fn backups_are_outside_everything_the_model_can_see() {
        let vault = TempDir::new("vault-mem5");
        let reg = memory_registry(&vault.0, "# Memory\n- secret curated note\n");
        execute_write(&reg, &ctx(false), &json!({ "path": "memory.md", "content": "# Memory\n- replaced\n" }))
            .await
            .unwrap();
        let name = backups(&vault.0).remove(0);

        let read = execute_read(&reg, &ctx(false), &json!({ "path": format!("{MEMORY_BACKUP_DIR}/{name}") })).await;
        assert!(read.is_err(), "read_file must not reach the backup set");

        let listed = execute_list_directory(&reg, &ctx(false), &json!({ "path": "." }))
            .await
            .unwrap_or_default();
        assert!(!listed.contains(MEMORY_BACKUP_DIR), "{listed}");
    }

    /// Ordinary notes keep the old plain-overwrite behaviour.
    #[tokio::test]
    async fn notes_are_not_given_memory_protections() {
        let vault = TempDir::new("vault-mem6");
        std::fs::create_dir_all(vault.0.join("notes")).unwrap();
        let reg = memory_registry(&vault.0, "# Memory\n- keep\n");
        std::fs::write(vault.0.join("notes/n.md"), "a".repeat(500)).unwrap();

        execute_write(&reg, &ctx(false), &json!({ "path": "notes/n.md", "content": "x" }))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(vault.0.join("notes/n.md")).unwrap(), "x");
        assert!(backups(&vault.0).is_empty());
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
