//! Append per-fire entries to `vault/triggers/logs.yaml`. Mirrors
//! [src/services/triggers/logs.ts](src/services/triggers/logs.ts).
//!
//! Schema:
//! ```yaml
//! entries:
//!   - timestamp: ISO
//!     conversationId: <trigger id>
//!     conversationTitle: <trigger title>
//!     triggered: true | false
//!     reasoning: <text>
//!     error: <optional>
//! ```
//! Capped at 1000 entries; oldest pruned when over.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::fs;

const MAX_LOG_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerLogEntry {
    pub timestamp: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "conversationTitle", default, skip_serializing_if = "Option::is_none")]
    pub conversation_title: Option<String>,
    pub triggered: bool,
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LogsFile {
    entries: Vec<TriggerLogEntry>,
}

pub async fn append(triggers_dir: &Path, entry: TriggerLogEntry) -> anyhow::Result<()> {
    fs::create_dir_all(triggers_dir).await?;
    let path = triggers_dir.join("logs.yaml");

    let mut file: LogsFile = if path.exists() {
        let text = fs::read_to_string(&path).await?;
        serde_yaml::from_str(&text).unwrap_or_default()
    } else {
        LogsFile::default()
    };

    // Newest first.
    file.entries.insert(0, entry);
    file.entries.truncate(MAX_LOG_ENTRIES);

    let yaml = serde_yaml::to_string(&file)?;
    fs::write(&path, yaml).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn appends_and_prunes() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..3 {
            append(
                tmp.path(),
                TriggerLogEntry {
                    timestamp: format!("ts-{}", i),
                    conversation_id: "abc".into(),
                    conversation_title: Some("t".into()),
                    triggered: true,
                    reasoning: format!("entry-{}", i),
                    error: None,
                },
            )
            .await
            .unwrap();
        }
        let path = tmp.path().join("logs.yaml");
        let text = std::fs::read_to_string(&path).unwrap();
        let f: LogsFile = serde_yaml::from_str(&text).unwrap();
        // Newest first.
        assert_eq!(f.entries[0].reasoning, "entry-2");
        assert_eq!(f.entries[2].reasoning, "entry-0");
    }
}
