//! Trigger schema + YAML I/O.
//!
//! Mirrors the TypeScript `Trigger` interface in [src/types/index.ts:145](src/types/index.ts#L145).
//! Messages and usage payloads are kept as `serde_yaml::Value` so we don't
//! have to fully model every Message variant — the scheduler only reads
//! `lastChecked` / `lastTriggered` / `history` and appends to `messages`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trigger {
    pub id: String,
    pub created: String,
    pub updated: String,
    pub title: String,
    pub model: String,
    pub enabled: bool,
    #[serde(rename = "triggerPrompt")]
    pub trigger_prompt: String,
    #[serde(rename = "intervalMinutes")]
    pub interval_minutes: u32,
    #[serde(rename = "lastChecked", default, skip_serializing_if = "Option::is_none")]
    pub last_checked: Option<String>,
    #[serde(rename = "lastTriggered", default, skip_serializing_if = "Option::is_none")]
    pub last_triggered: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<TriggerAttempt>>,
    #[serde(default)]
    pub messages: Vec<Value>,
    /// Preserve any fields we don't model (forward-compat).
    #[serde(flatten)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerAttempt {
    pub timestamp: String,
    pub result: TriggerVerdict,
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerVerdict {
    Triggered,
    Skipped,
    Error,
}

/// Output of executing a trigger once. Returned from the executor and posted
/// to the SPA as the `/api/triggers/{id}/run` response body.
#[derive(Debug, Clone, Serialize)]
pub struct TriggerRunOutcome {
    pub result: TriggerVerdict,
    pub response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

/// Scan `vault/triggers/*.yaml`, skip `logs.yaml`, return parsed triggers
/// paired with their on-disk paths.
pub async fn load_all(triggers_dir: &Path) -> anyhow::Result<Vec<(PathBuf, Trigger)>> {
    if !triggers_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut entries = fs::read_dir(triggers_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".yaml") || name == "logs.yaml" {
            continue;
        }
        match load_one(&path).await {
            Ok(t) => out.push((path, t)),
            Err(e) => tracing::warn!("failed to parse trigger {}: {}", path.display(), e),
        }
    }
    Ok(out)
}

pub async fn load_one(path: &Path) -> anyhow::Result<Trigger> {
    let text = fs::read_to_string(path).await?;
    let trigger: Trigger = serde_yaml::from_str(&text)?;
    Ok(trigger)
}

/// Load + apply a mutation + write back. Mirrors the TS
/// `vaultService.updateTrigger` pattern.
pub async fn update<F>(path: &Path, mutate: F) -> anyhow::Result<Trigger>
where
    F: FnOnce(&mut Trigger),
{
    let mut trigger = load_one(path).await?;
    mutate(&mut trigger);
    let yaml = serde_yaml::to_string(&trigger)?;
    fs::write(path, yaml).await?;
    Ok(trigger)
}

/// Find a trigger file by id. Matches both `{id}.yaml` and `{id}-slug.yaml`.
pub async fn find_by_id(triggers_dir: &Path, id: &str) -> anyhow::Result<Option<PathBuf>> {
    if !triggers_dir.exists() {
        return Ok(None);
    }
    let exact = format!("{}.yaml", id);
    let prefix = format!("{}-", id);
    let mut entries = fs::read_dir(triggers_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name == exact || (name.starts_with(&prefix) && name.ends_with(".yaml")) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Append a user/assistant message pair to a trigger when it fires. Mirrors
/// the TS `onTriggerFired` callback in [src/contexts/TriggerContext.tsx](src/contexts/TriggerContext.tsx).
pub fn push_fire_messages(trigger: &mut Trigger, prompt: &str, response: &str, model: &str, usage: Option<&Value>, now: &str) {
    let mut user_msg = Mapping::new();
    user_msg.insert(Value::String("role".into()), Value::String("user".into()));
    user_msg.insert(Value::String("timestamp".into()), Value::String(now.into()));
    user_msg.insert(Value::String("content".into()), Value::String(prompt.into()));
    trigger.messages.push(Value::Mapping(user_msg));

    let mut asst_msg = Mapping::new();
    asst_msg.insert(Value::String("role".into()), Value::String("assistant".into()));
    asst_msg.insert(Value::String("timestamp".into()), Value::String(now.into()));
    asst_msg.insert(Value::String("content".into()), Value::String(response.into()));
    asst_msg.insert(Value::String("model".into()), Value::String(model.into()));
    if let Some(u) = usage {
        asst_msg.insert(Value::String("usage".into()), u.clone());
    }
    trigger.messages.push(Value::Mapping(asst_msg));
}

/// Insert an attempt at the head of history, capped at 50 entries to match
/// the TS `MAX_HISTORY_ENTRIES`.
pub fn push_history(trigger: &mut Trigger, attempt: TriggerAttempt) {
    const MAX_HISTORY: usize = 50;
    let mut history = trigger.history.take().unwrap_or_default();
    history.insert(0, attempt);
    history.truncate(MAX_HISTORY);
    trigger.history = Some(history);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_yaml(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        path
    }

    #[tokio::test]
    async fn roundtrips_trigger_with_extras() {
        let tmp = tempfile::tempdir().unwrap();
        write_yaml(
            tmp.path(),
            "abc.yaml",
            r#"id: abc
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
title: ping
model: openrouter/anthropic/claude-haiku-4.5
enabled: true
triggerPrompt: ping the world
intervalMinutes: 60
messages: []
someFutureField: keep-me
"#,
        );
        let t = load_one(&tmp.path().join("abc.yaml")).await.unwrap();
        assert_eq!(t.id, "abc");
        assert!(t.extra.contains_key(Value::String("someFutureField".into())));

        // Round-trip via update preserves extras.
        update(&tmp.path().join("abc.yaml"), |t| {
            t.last_checked = Some("2026-01-01T01:00:00Z".into());
        })
        .await
        .unwrap();
        let reloaded = load_one(&tmp.path().join("abc.yaml")).await.unwrap();
        assert_eq!(reloaded.last_checked.as_deref(), Some("2026-01-01T01:00:00Z"));
        assert!(reloaded.extra.contains_key(Value::String("someFutureField".into())));
    }

    #[tokio::test]
    async fn load_all_skips_logs_and_non_yaml() {
        let tmp = tempfile::tempdir().unwrap();
        write_yaml(tmp.path(), "logs.yaml", "entries: []\n");
        write_yaml(tmp.path(), "readme.md", "# notes");
        write_yaml(
            tmp.path(),
            "real.yaml",
            r#"id: real
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
title: t
model: x/y
enabled: true
triggerPrompt: p
intervalMinutes: 30
messages: []
"#,
        );
        let all = load_all(tmp.path()).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].1.id, "real");
    }

    #[test]
    fn history_caps_at_50() {
        let mut t = Trigger {
            id: "x".into(),
            created: "now".into(),
            updated: "now".into(),
            title: "x".into(),
            model: "x/y".into(),
            enabled: true,
            trigger_prompt: "p".into(),
            interval_minutes: 1,
            last_checked: None,
            last_triggered: None,
            history: None,
            messages: vec![],
            extra: Default::default(),
        };
        for i in 0..60 {
            push_history(
                &mut t,
                TriggerAttempt {
                    timestamp: format!("ts-{}", i),
                    result: TriggerVerdict::Skipped,
                    reasoning: "".into(),
                    error: None,
                    usage: None,
                },
            );
        }
        assert_eq!(t.history.as_ref().unwrap().len(), 50);
        // Most recent is first (matches TS .unshift behavior).
        assert_eq!(t.history.unwrap()[0].timestamp, "ts-59");
    }
}
