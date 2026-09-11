//! Vault writer: append assistant messages to conversation YAML and update
//! titles. Mirrors [server/vault-writer.ts](server/vault-writer.ts) so the
//! Tauri client's file watcher picks up changes in the same shape.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use tokio::fs;

use crate::{compaction::NewCompacted, providers::Usage, vault::Vault};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Conversation {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    model: String,
    created: String,
    updated: String,
    #[serde(default)]
    messages: Vec<Value>,
    // Preserve any other fields (memory_version, lastCompactedAt, etc.).
    #[serde(flatten)]
    extra: serde_yaml::Mapping,
}

/// One tool invocation persisted onto an assistant message. Mirrors the
/// frontend `ToolUse` interface in [src/types/index.ts](src/types/index.ts) so
/// the YAML round-trips into `Message.toolUse` and the pills re-render on reload.
#[derive(Debug, Clone, Serialize)]
pub struct PersistedToolUse {
    #[serde(rename = "type")]
    pub tool_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

pub struct AssistantWrite {
    pub conversation_id: String,
    pub assistant_message_id: String,
    pub content: String,
    /// Present when the turn failed. Persisting this on the same assistant
    /// record as partial content and tool history keeps the failure atomic.
    pub error: Option<String>,
    /// Present when the turn produced a real answer but had to stop short (for
    /// example because it filled its context budget). Stored as a stable code so
    /// the UI owns the wording; absence means an ordinary complete answer.
    pub incomplete_reason: Option<String>,
    pub usage: Option<Usage>,
    /// A compaction summary to insert at its boundary in the same write.
    pub compacted: Option<NewCompacted>,
    /// Tool calls/results observed this turn, persisted so pills survive reload.
    pub tool_use: Vec<PersistedToolUse>,
}

/// Append an assistant message to the conversation file. When `w.compacted` is
/// set, the compacted summary message is inserted at its boundary (immediately
/// before the anchor message) in the SAME read-modify-write, so the client's
/// file watcher only sees one change at completion (no mid-stream reload) and
/// there's no second racing write.
pub async fn append_assistant_message(vault: &Vault, w: AssistantWrite) -> anyhow::Result<()> {
    let file_path = find_conversation_file(vault, &w.conversation_id).await?;
    let text = fs::read_to_string(&file_path).await?;
    let mut conversation: Conversation = serde_yaml::from_str(&text)?;

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // Insert the compacted summary message (if any) before its anchor message,
    // and stamp lastCompactedAt. Done before appending the assistant reply so
    // the new reply still lands at the end.
    if let Some(nc) = w.compacted {
        insert_compacted_message(&mut conversation, nc, &now);
    }

    let mut msg = serde_yaml::Mapping::new();
    msg.insert(Value::String("id".into()), Value::String(w.assistant_message_id));
    msg.insert(Value::String("role".into()), Value::String("assistant".into()));
    msg.insert(Value::String("timestamp".into()), Value::String(now.clone()));
    msg.insert(Value::String("content".into()), Value::String(w.content));
    if let Some(error) = w.error {
        msg.insert(Value::String("error".into()), Value::String(error));
    }
    if let Some(reason) = w.incomplete_reason {
        msg.insert(Value::String("incompleteReason".into()), Value::String(reason));
    }
    if let Some(usage) = w.usage {
        msg.insert(
            Value::String("usage".into()),
            serde_yaml::to_value(usage).unwrap_or(Value::Null),
        );
    }
    if !w.tool_use.is_empty() {
        msg.insert(
            Value::String("toolUse".into()),
            serde_yaml::to_value(&w.tool_use).unwrap_or(Value::Null),
        );
    }
    conversation.messages.push(Value::Mapping(msg));
    conversation.updated = now;

    let yaml = serde_yaml::to_string(&conversation)?;
    write_atomic(&file_path, &yaml).await?;

    // Also write the markdown preview that the SPA reads in some views.
    let md = render_markdown_preview(&conversation);
    let md_path = file_path.with_extension("md");
    let _ = write_atomic(&md_path, &md).await;

    tracing::info!(
        "vault_writer: appended assistant message to {}",
        file_path.file_name().unwrap_or_default().to_string_lossy()
    );
    Ok(())
}

/// Insert a `compacted` summary message immediately before its anchor message
/// (the first retained message) and stamp `lastCompactedAt`. If the anchor id is
/// missing or not found, the summary is dropped (it was still used for this
/// turn's send; the next turn regenerates it) and a warning is logged.
fn insert_compacted_message(conversation: &mut Conversation, nc: NewCompacted, now: &str) {
    let Some(anchor_id) = nc.anchor_id.as_deref() else {
        tracing::warn!("compaction: no anchor id; not persisting compacted message");
        return;
    };
    let pos = conversation.messages.iter().position(|m| {
        m.as_mapping()
            .and_then(|map| map.get(Value::String("id".into())))
            .and_then(|v| v.as_str())
            == Some(anchor_id)
    });
    let Some(pos) = pos else {
        tracing::warn!(
            "compaction: anchor id {} not found; not persisting compacted message",
            anchor_id
        );
        return;
    };

    let mut cmap = serde_yaml::Mapping::new();
    cmap.insert(
        Value::String("id".into()),
        Value::String(format!("compact-{}", chrono::Utc::now().timestamp_millis())),
    );
    cmap.insert(Value::String("role".into()), Value::String("compacted".into()));
    cmap.insert(Value::String("timestamp".into()), Value::String(now.to_string()));
    cmap.insert(Value::String("content".into()), Value::String(nc.content));
    conversation.messages.insert(pos, Value::Mapping(cmap));

    conversation.extra.insert(
        Value::String("lastCompactedAt".into()),
        Value::String(now.to_string()),
    );
    tracing::info!("compaction: inserted compacted message before {}", anchor_id);
}

/// Write via a unique temp file + rename so a reader never observes a partially
/// written conversation. A failed turn persists content, tool history, and its
/// error in one record; a torn write would strand that turn mid-file. The temp
/// name never ends in `.yaml`, so listing/search skip it while it exists.
async fn write_atomic(path: &Path, contents: &str) -> anyhow::Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, contents).await?;
    if let Err(e) = fs::rename(&temp, path).await {
        let _ = fs::remove_file(&temp).await;
        return Err(e.into());
    }
    Ok(())
}

/// Update the conversation title and rename the file to include a slug.
pub async fn update_title(vault: &Vault, conversation_id: &str, new_title: &str) -> anyhow::Result<()> {
    let file_path = find_conversation_file(vault, conversation_id).await?;
    let text = fs::read_to_string(&file_path).await?;
    let mut conversation: Conversation = serde_yaml::from_str(&text)?;

    conversation.title = Some(new_title.to_string());
    conversation.updated = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let new_filename = generate_filename(conversation_id, Some(new_title));
    let new_path = file_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("conversation file has no parent"))?
        .join(new_filename);

    let yaml = serde_yaml::to_string(&conversation)?;
    write_atomic(&new_path, &yaml).await?;

    let md = render_markdown_preview(&conversation);
    let md_path = new_path.with_extension("md");
    let _ = write_atomic(&md_path, &md).await;

    if new_path != file_path {
        let _ = fs::remove_file(&file_path).await;
        let _ = fs::remove_file(file_path.with_extension("md")).await;
    }

    tracing::info!("vault_writer: updated title to \"{}\"", new_title);
    Ok(())
}

async fn find_conversation_file(vault: &Vault, conversation_id: &str) -> anyhow::Result<PathBuf> {
    let dir = vault.resolve("conversations")?;
    let mut entries = fs::read_dir(&dir).await?;
    let exact = format!("{}.yaml", conversation_id);
    let prefix = format!("{}-", conversation_id);
    while let Some(entry) = entries.next_entry().await? {
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();
        if !name.ends_with(".yaml") {
            continue;
        }
        if name == exact || name.starts_with(&prefix) {
            return Ok(entry.path());
        }
    }
    anyhow::bail!(
        "conversation file not found for id {} (looked in {})",
        conversation_id,
        dir.display()
    )
}

fn generate_filename(id: &str, title: Option<&str>) -> String {
    match title {
        Some(t) => {
            let slug = generate_slug(t);
            if slug.is_empty() {
                format!("{}.yaml", id)
            } else {
                format!("{}-{}.yaml", id, slug)
            }
        }
        None => format!("{}.yaml", id),
    }
}

fn generate_slug(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut slug = String::new();
    let mut last_dash = true;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    trimmed.chars().take(50).collect()
}

/// Human wording for an `incompleteReason` code in the generated preview. The
/// SPA renders its own copy; unknown codes are skipped rather than guessed at.
fn incomplete_note(reason: &str) -> Option<&'static str> {
    match reason {
        "context_budget" => Some(
            "Stopped early: this turn reached the model's context limit, so the answer uses \
             only the material gathered before that point.",
        ),
        "output_limit" => Some(
            "Cut off: the model reached its maximum reply length, so this answer stops \
             mid-thought.",
        ),
        "iteration_limit" => Some(
            "Stopped early: this turn reached Alloy's tool-use safety limit, so the answer \
             uses only the material gathered before that point.",
        ),
        _ => None,
    }
}

fn render_markdown_preview(c: &Conversation) -> String {
    let frontmatter = {
        let mut m = serde_yaml::Mapping::new();
        m.insert(Value::String("id".into()), Value::String(c.id.clone()));
        m.insert(Value::String("created".into()), Value::String(c.created.clone()));
        m.insert(Value::String("updated".into()), Value::String(c.updated.clone()));
        m.insert(Value::String("model".into()), Value::String(c.model.clone()));
        if let Some(t) = &c.title {
            m.insert(Value::String("title".into()), Value::String(t.clone()));
        }
        serde_yaml::to_string(&Value::Mapping(m)).unwrap_or_default()
    };

    let assistant_name = &c.model;
    let body = c
        .messages
        .iter()
        .filter_map(|v| {
            let m = v.as_mapping()?;
            let role = m.get(Value::String("role".into()))?.as_str()?;
            if role == "log" || role == "compacted" {
                return None;
            }
            let content = m.get(Value::String("content".into()))?.as_str().unwrap_or("");
            let error = m
                .get(Value::String("error".into()))
                .and_then(Value::as_str);
            let label = if role == "user" {
                "You".to_string()
            } else {
                assistant_name.clone()
            };
            let mut rendered = match error {
                Some(error) if content.trim().is_empty() => format!("**Error:** {}", error),
                Some(error) => format!("{}\n\n**Error:** {}", content, error),
                None => content.to_string(),
            };
            // The preview is read in Obsidian, where there is no UI to carry the
            // badge — so an answer built on partial work has to say so here.
            if let Some(note) = m
                .get(Value::String("incompleteReason".into()))
                .and_then(Value::as_str)
                .and_then(incomplete_note)
            {
                rendered = format!("{}\n\n_{}_", rendered, note);
            }
            Some(format!("### {}\n\n{}", label, rendered))
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    format!("---\n{}---\n\n{}\n", frontmatter, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_basics() {
        assert_eq!(generate_slug("Hello World"), "hello-world");
        assert_eq!(generate_slug("  Mixed!! Punct?  "), "mixed-punct");
        assert_eq!(
            generate_slug("Very long title that exceeds the fifty character limit imposed by the slug function"),
            "very-long-title-that-exceeds-the-fifty-character-l"
        );
    }

    #[test]
    fn filename_with_and_without_title() {
        assert_eq!(generate_filename("abc123", None), "abc123.yaml");
        assert_eq!(generate_filename("abc123", Some("Hello!")), "abc123-hello.yaml");
        // Title that slugs to empty should fall back to id-only.
        assert_eq!(generate_filename("abc123", Some("!!!")), "abc123.yaml");
    }

    #[tokio::test]
    async fn assistant_error_is_atomic_with_partial_content_and_tools() {
        let temp = tempfile::tempdir().unwrap();
        let conversations = temp.path().join("conversations");
        fs::create_dir_all(&conversations).await.unwrap();
        let path = conversations.join("conv-error.yaml");
        fs::write(
            &path,
            "id: conv-error\nmodel: mlx/test\ncreated: 2024-01-01T00:00:00Z\nupdated: 2024-01-01T00:00:00Z\nmessages: []\n",
        )
        .await
        .unwrap();
        let vault = Vault::new(temp.path().to_path_buf()).unwrap();

        append_assistant_message(
            &vault,
            AssistantWrite {
                conversation_id: "conv-error".into(),
                assistant_message_id: "assistant-error".into(),
                content: "Partial research.".into(),
                error: Some("model returned no final text".into()),
                incomplete_reason: None,
                usage: None,
                compacted: None,
                tool_use: vec![PersistedToolUse {
                    tool_type: "search_directory".into(),
                    input: Some(serde_json::json!({ "query": "cost basis" })),
                    result: Some("no result".into()),
                    is_error: None,
                }],
            },
        )
        .await
        .unwrap();

        let saved: Conversation = serde_yaml::from_str(&fs::read_to_string(&path).await.unwrap())
            .unwrap();
        let message = saved.messages.last().unwrap().as_mapping().unwrap();
        assert_eq!(
            message
                .get(Value::String("error".into()))
                .and_then(Value::as_str),
            Some("model returned no final text")
        );
        assert!(message.contains_key(Value::String("toolUse".into())));
        assert_eq!(
            message
                .get(Value::String("content".into()))
                .and_then(Value::as_str),
            Some("Partial research.")
        );

        let preview = fs::read_to_string(path.with_extension("md")).await.unwrap();
        assert!(preview.contains("Partial research."));
        assert!(preview.contains("**Error:** model returned no final text"));

        // The temp file used for the atomic rename must not survive the write,
        // or the vault would accumulate junk beside every conversation.
        let mut entries = fs::read_dir(&conversations).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        assert_eq!(names, vec!["conv-error.md", "conv-error.yaml"]);
    }

    /// A turn cut short by its context budget is a real answer, so it is stored
    /// as content plus a marker — never as an error — and the Obsidian preview
    /// has to carry the caveat too, since it has no UI to show a badge.
    #[tokio::test]
    async fn an_answer_cut_short_is_labelled_in_both_the_yaml_and_the_preview() {
        let temp = tempfile::tempdir().unwrap();
        let conversations = temp.path().join("conversations");
        fs::create_dir_all(&conversations).await.unwrap();
        let path = conversations.join("conv-partial.yaml");
        fs::write(
            &path,
            "id: conv-partial\nmodel: mlx/test\ncreated: 2024-01-01T00:00:00Z\nupdated: 2024-01-01T00:00:00Z\nmessages: []\n",
        )
        .await
        .unwrap();
        let vault = Vault::new(temp.path().to_path_buf()).unwrap();

        append_assistant_message(
            &vault,
            AssistantWrite {
                conversation_id: "conv-partial".into(),
                assistant_message_id: "assistant-partial".into(),
                content: "Here is what I found.".into(),
                error: None,
                incomplete_reason: Some("context_budget".into()),
                usage: None,
                compacted: None,
                tool_use: vec![],
            },
        )
        .await
        .unwrap();

        let saved: Conversation = serde_yaml::from_str(&fs::read_to_string(&path).await.unwrap())
            .unwrap();
        let message = saved.messages.last().unwrap().as_mapping().unwrap();
        assert_eq!(
            message
                .get(Value::String("incompleteReason".into()))
                .and_then(Value::as_str),
            Some("context_budget")
        );
        assert!(!message.contains_key(Value::String("error".into())));

        let preview = fs::read_to_string(path.with_extension("md")).await.unwrap();
        assert!(preview.contains("Here is what I found."));
        assert!(preview.contains("Stopped early"), "got: {preview}");
        assert!(!preview.contains("**Error:**"));
    }

    /// An unrecognized code must not invent wording in the preview.
    #[test]
    fn unknown_incomplete_codes_are_not_guessed_at() {
        assert!(incomplete_note("context_budget").is_some());
        assert!(incomplete_note("output_limit").is_some());
        assert!(incomplete_note("iteration_limit").is_some());
        assert!(incomplete_note("something_new").is_none());
    }
}

// Helper used by router setup so we don't import Path elsewhere.
#[allow(dead_code)]
fn ensure_dir_exists(p: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(p)
}
