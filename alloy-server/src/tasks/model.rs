//! Scheduled-task schema and YAML I/O.

use std::path::{Path, PathBuf};

use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub created: String,
    pub updated: String,
    pub title: String,
    pub model: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: TaskSchedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<TaskTrigger>,
    #[serde(
        rename = "lastScheduledAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_scheduled_at: Option<String>,
    #[serde(rename = "lastRunAt", default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(
        rename = "lastDeliveredAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_delivered_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<TaskAttempt>>,
    #[serde(default)]
    pub messages: Vec<Value>,
    /// Preserve fields added by newer Alloy versions.
    #[serde(flatten)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSchedule {
    pub cron: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTrigger {
    pub condition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskAttempt {
    pub timestamp: String,
    pub result: TaskVerdict,
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskVerdict {
    Completed,
    Triggered,
    Skipped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskRunOutcome {
    pub result: TaskVerdict,
    pub response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

pub async fn load_all(tasks_dir: &Path) -> anyhow::Result<Vec<(PathBuf, ScheduledTask)>> {
    if !tasks_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut entries = fs::read_dir(tasks_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".yaml") {
            continue;
        }
        match load_one(&path).await {
            Ok(task) => out.push((path, task)),
            Err(e) => tracing::warn!("failed to parse task {}: {}", path.display(), e),
        }
    }
    Ok(out)
}

pub async fn load_one(path: &Path) -> anyhow::Result<ScheduledTask> {
    let text = fs::read_to_string(path).await?;
    Ok(serde_yaml::from_str(&text)?)
}

pub async fn update<F>(path: &Path, mutate: F) -> anyhow::Result<ScheduledTask>
where
    F: FnOnce(&mut ScheduledTask),
{
    let mut task = load_one(path).await?;
    mutate(&mut task);
    write_atomic(path, &task).await?;
    Ok(task)
}

pub async fn write_atomic(path: &Path, task: &ScheduledTask) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let yaml = serde_yaml::to_string(task)?;
    let temp = path.with_extension("yaml.tmp");
    fs::write(&temp, yaml).await?;
    fs::rename(&temp, path).await?;
    Ok(())
}

pub async fn find_by_id(tasks_dir: &Path, id: &str) -> anyhow::Result<Option<PathBuf>> {
    if !tasks_dir.exists() {
        return Ok(None);
    }
    let exact = format!("{}.yaml", id);
    let prefix = format!("{}-", id);
    let mut entries = fs::read_dir(tasks_dir).await?;
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

pub fn push_delivery_messages(
    task: &mut ScheduledTask,
    response: &str,
    usage: Option<&Value>,
    now: &str,
) {
    let mut user_msg = Mapping::new();
    user_msg.insert(Value::String("role".into()), Value::String("user".into()));
    user_msg.insert(Value::String("timestamp".into()), Value::String(now.into()));
    user_msg.insert(
        Value::String("content".into()),
        Value::String(task.prompt.clone()),
    );
    task.messages.push(Value::Mapping(user_msg));

    let mut assistant_msg = Mapping::new();
    assistant_msg.insert(
        Value::String("role".into()),
        Value::String("assistant".into()),
    );
    assistant_msg.insert(Value::String("timestamp".into()), Value::String(now.into()));
    assistant_msg.insert(
        Value::String("content".into()),
        Value::String(response.into()),
    );
    assistant_msg.insert(
        Value::String("model".into()),
        Value::String(task.model.clone()),
    );
    if let Some(value) = usage {
        assistant_msg.insert(Value::String("usage".into()), value.clone());
    }
    task.messages.push(Value::Mapping(assistant_msg));
}

pub fn push_history(task: &mut ScheduledTask, attempt: TaskAttempt) {
    const MAX_HISTORY: usize = 50;
    let mut history = task.history.take().unwrap_or_default();
    history.insert(0, attempt);
    history.truncate(MAX_HISTORY);
    task.history = Some(history);
}

pub fn local_timezone() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|value| value.parse::<Tz>().ok().map(|_| value))
        .unwrap_or_else(|| "UTC".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn roundtrips_task_with_unknown_fields() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("task.yaml");
        std::fs::write(
            &path,
            r#"id: abc
created: now
updated: now
title: Task
model: mlx/test
enabled: true
prompt: Do it
schedule:
  cron: '0 8 * * 1'
  timezone: America/Los_Angeles
messages: []
futureField: keep
"#,
        )
        .unwrap();
        update(&path, |task| task.last_run_at = Some("later".into()))
            .await
            .unwrap();
        let task = load_one(&path).await.unwrap();
        assert_eq!(task.last_run_at.as_deref(), Some("later"));
        assert!(task.extra.contains_key(Value::String("futureField".into())));
    }
}
