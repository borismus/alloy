//! Vault writer: append assistant messages to conversation YAML and update
//! titles. Mirrors [server/vault-writer.ts](server/vault-writer.ts) so the
//! Tauri client's file watcher picks up changes in the same shape.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use tokio::fs;

use crate::{providers::Usage, vault::Vault};

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

pub struct AssistantWrite {
    pub conversation_id: String,
    pub assistant_message_id: String,
    pub content: String,
    pub usage: Option<Usage>,
}

/// Append an assistant message to the conversation file.
pub async fn append_assistant_message(vault: &Vault, w: AssistantWrite) -> anyhow::Result<()> {
    let file_path = find_conversation_file(vault, &w.conversation_id).await?;
    let text = fs::read_to_string(&file_path).await?;
    let mut conversation: Conversation = serde_yaml::from_str(&text)?;

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let mut msg = serde_yaml::Mapping::new();
    msg.insert(Value::String("id".into()), Value::String(w.assistant_message_id));
    msg.insert(Value::String("role".into()), Value::String("assistant".into()));
    msg.insert(Value::String("timestamp".into()), Value::String(now.clone()));
    msg.insert(Value::String("content".into()), Value::String(w.content));
    if let Some(usage) = w.usage {
        msg.insert(
            Value::String("usage".into()),
            serde_yaml::to_value(usage).unwrap_or(Value::Null),
        );
    }
    conversation.messages.push(Value::Mapping(msg));
    conversation.updated = now;

    let yaml = serde_yaml::to_string(&conversation)?;
    fs::write(&file_path, yaml).await?;

    // Also write the markdown preview that the SPA reads in some views.
    let md = render_markdown_preview(&conversation);
    let md_path = file_path.with_extension("md");
    let _ = fs::write(&md_path, md).await;

    tracing::info!(
        "vault_writer: appended assistant message to {}",
        file_path.file_name().unwrap_or_default().to_string_lossy()
    );
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
    fs::write(&new_path, yaml).await?;

    let md = render_markdown_preview(&conversation);
    let md_path = new_path.with_extension("md");
    let _ = fs::write(&md_path, md).await;

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
            if role == "log" {
                return None;
            }
            let content = m.get(Value::String("content".into()))?.as_str().unwrap_or("");
            let label = if role == "user" {
                "You".to_string()
            } else {
                assistant_name.clone()
            };
            Some(format!("### {}\n\n{}", label, content))
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
}

// Helper used by router setup so we don't import Path elsewhere.
#[allow(dead_code)]
fn ensure_dir_exists(p: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(p)
}
