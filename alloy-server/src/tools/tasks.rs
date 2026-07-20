//! Model-callable scheduled-task creation.

use chrono::{SecondsFormat, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use serde_yaml::Mapping;
use tokio::fs;

use crate::tasks::{
    model::{ScheduledTask, TaskSchedule, TaskTrigger},
    scheduler::parse_cron,
};
use crate::tools::{input_string, ToolRegistry};

pub async fn execute(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let title = required(input, "title")?;
    let prompt = required(input, "prompt")?;
    let cron_expression = required(input, "cron")?;
    let schedule =
        parse_cron(cron_expression).map_err(|e| format!("create_scheduled_task: {}", e))?;

    let timezone = input_string(input, "timezone")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(crate::tasks::model::local_timezone);
    let tz: Tz = timezone.parse().map_err(|_| {
        format!(
            "create_scheduled_task: unknown IANA timezone '{}'",
            timezone
        )
    })?;

    let model = match input_string(input, "model") {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => registry.config.default_model.clone().ok_or_else(|| {
            "create_scheduled_task: no model specified and config has no defaultModel".to_string()
        })?,
    };
    let trigger = input_string(input, "trigger_condition")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|condition| TaskTrigger {
            condition: condition.to_string(),
        });
    let email = crate::tools::input_bool(input, "email").unwrap_or(false);

    let now = Utc::now();
    let id = generate_task_id(now);
    let slug = slugify(title);
    let filename = if slug.is_empty() {
        format!("{}.yaml", id)
    } else {
        format!("{}-{}.yaml", id, slug)
    };
    let tasks_dir = registry.vault.resolve("tasks").map_err(|e| e.to_string())?;
    fs::create_dir_all(&tasks_dir).await.map_err(|e| {
        format!(
            "create_scheduled_task: failed to create tasks directory: {}",
            e
        )
    })?;
    let path = tasks_dir.join(filename);
    if path.exists() {
        return Err(format!(
            "create_scheduled_task: file already exists for {}",
            id
        ));
    }

    let now_iso = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let task = ScheduledTask {
        id: id.clone(),
        created: now_iso.clone(),
        updated: now_iso,
        title: title.to_string(),
        model,
        enabled: true,
        email,
        prompt: prompt.to_string(),
        schedule: TaskSchedule {
            cron: cron_expression.to_string(),
            timezone: timezone.clone(),
        },
        trigger,
        last_scheduled_at: None,
        last_run_at: None,
        last_delivered_at: None,
        history: None,
        messages: Vec::new(),
        extra: Mapping::new(),
    };
    crate::tasks::model::write_atomic(&path, &task)
        .await
        .map_err(|e| format!("create_scheduled_task: serialize/write failed: {}", e))?;

    let next = schedule
        .after(&now.with_timezone(&tz))
        .next()
        .map(|value| value.format("%a, %b %-d at %-I:%M %p %Z").to_string())
        .unwrap_or_else(|| "none".into());
    let kind = if task.trigger.is_some() {
        "conditional — delivers only when its trigger condition is met"
    } else {
        "unconditional — delivers every successful run"
    };
    let email_note = if task.email {
        " Delivered results are emailed."
    } else {
        ""
    };
    Ok(format!(
        "Created scheduled task \"{}\" (id: {}). Schedule: {} (`{}`, {}). Next run: {}. It is {}.{}",
        title,
        id,
        describe_cron(cron_expression),
        cron_expression,
        timezone,
        next,
        kind,
        email_note,
    ))
}

pub async fn execute_update(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let id = input_string(input, "task_id")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "update_scheduled_task: missing or empty 'task_id'".to_string())?;
    let tasks_dir = registry.vault.resolve("tasks").map_err(|e| e.to_string())?;
    let path = crate::tasks::model::find_by_id(&tasks_dir, id)
        .await
        .map_err(|e| format!("update_scheduled_task: failed to find task: {}", e))?
        .ok_or_else(|| format!("update_scheduled_task: task not found: {}", id))?;
    let mut task = crate::tasks::model::load_one(&path)
        .await
        .map_err(|e| format!("update_scheduled_task: failed to load task: {}", e))?;

    let now = Utc::now();
    let now_iso = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let changed = apply_updates(&mut task, input, &now_iso)?;
    crate::tasks::model::write_atomic(&path, &task)
        .await
        .map_err(|e| format!("update_scheduled_task: serialize/write failed: {}", e))?;

    let tz: Tz = task.schedule.timezone.parse().map_err(|_| {
        format!(
            "update_scheduled_task: unknown IANA timezone '{}'",
            task.schedule.timezone
        )
    })?;
    let schedule =
        parse_cron(&task.schedule.cron).map_err(|e| format!("update_scheduled_task: {}", e))?;
    let next = if task.enabled {
        schedule
            .after(&now.with_timezone(&tz))
            .next()
            .map(|value| value.format("%a, %b %-d at %-I:%M %p %Z").to_string())
            .unwrap_or_else(|| "none".into())
    } else {
        "disabled".into()
    };
    let kind = if task.trigger.is_some() {
        "conditional delivery"
    } else {
        "delivery after every successful run"
    };
    Ok(format!(
        "Updated scheduled task \"{}\" (id: {}). Changed: {}. Schedule: {} (`{}`, {}). Next run: {}. It uses {} and email is {}.",
        task.title,
        task.id,
        changed.join(", "),
        describe_cron(&task.schedule.cron),
        task.schedule.cron,
        task.schedule.timezone,
        next,
        kind,
        if task.email { "on" } else { "off" },
    ))
}

fn apply_updates(
    task: &mut ScheduledTask,
    input: &Value,
    now_iso: &str,
) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();

    if let Some(value) = optional_nonempty_string(input, "title")? {
        task.title = value;
        changed.push("title".into());
    }
    if let Some(value) = optional_nonempty_string(input, "prompt")? {
        task.prompt = value;
        changed.push("prompt".into());
    }
    if let Some(value) = optional_nonempty_string(input, "model")? {
        task.model = value;
        changed.push("model".into());
    }
    if let Some(value) = optional_bool(input, "enabled")? {
        task.enabled = value;
        changed.push("enabled".into());
    }
    if let Some(value) = optional_bool(input, "email")? {
        task.email = value;
        changed.push("email".into());
    }

    let cron = optional_nonempty_string(input, "cron")?;
    let timezone = optional_nonempty_string(input, "timezone")?;
    if cron.is_some() || timezone.is_some() {
        let next_cron = cron.as_deref().unwrap_or(&task.schedule.cron);
        let next_timezone = timezone.as_deref().unwrap_or(&task.schedule.timezone);
        parse_cron(next_cron).map_err(|e| format!("update_scheduled_task: {}", e))?;
        next_timezone.parse::<Tz>().map_err(|_| {
            format!(
                "update_scheduled_task: unknown IANA timezone '{}'",
                next_timezone
            )
        })?;
        let schedule_changed =
            next_cron != task.schedule.cron || next_timezone != task.schedule.timezone;
        task.schedule.cron = next_cron.to_string();
        task.schedule.timezone = next_timezone.to_string();
        if schedule_changed {
            // Treat the edit time as the new schedule baseline so changing a
            // cron expression doesn't immediately catch up an occurrence from
            // the old schedule.
            task.last_scheduled_at = Some(now_iso.to_string());
        }
        if cron.is_some() {
            changed.push("schedule".into());
        }
        if timezone.is_some() {
            changed.push("timezone".into());
        }
    }

    if let Some(raw) = input.get("trigger_condition") {
        let condition = raw.as_str().ok_or_else(|| {
            "update_scheduled_task: 'trigger_condition' must be a string".to_string()
        })?;
        let condition = condition.trim();
        task.trigger = if condition.is_empty() {
            None
        } else {
            Some(TaskTrigger {
                condition: condition.to_string(),
            })
        };
        changed.push("delivery condition".into());
    }

    if changed.is_empty() {
        return Err("update_scheduled_task: provide at least one field to update".into());
    }
    task.updated = now_iso.to_string();
    Ok(changed)
}

fn optional_nonempty_string(input: &Value, name: &str) -> Result<Option<String>, String> {
    let Some(raw) = input.get(name) else {
        return Ok(None);
    };
    let value = raw
        .as_str()
        .ok_or_else(|| format!("update_scheduled_task: '{}' must be a string", name))?
        .trim();
    if value.is_empty() {
        return Err(format!("update_scheduled_task: '{}' cannot be empty", name));
    }
    Ok(Some(value.to_string()))
}

fn optional_bool(input: &Value, name: &str) -> Result<Option<bool>, String> {
    let Some(raw) = input.get(name) else {
        return Ok(None);
    };
    if let Some(value) = raw.as_bool() {
        return Ok(Some(value));
    }
    match raw.as_str().map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("true") => Ok(Some(true)),
        Some(value) if value.eq_ignore_ascii_case("false") => Ok(Some(false)),
        _ => Err(format!(
            "update_scheduled_task: '{}' must be true or false",
            name
        )),
    }
}

fn required<'a>(input: &'a Value, name: &str) -> Result<&'a str, String> {
    input_string(input, name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("create_scheduled_task: missing or empty '{}'", name))
}

fn describe_cron(expression: &str) -> String {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return "Invalid schedule".into();
    }
    let (minute, hour, day, month, weekday) =
        (fields[0], fields[1], fields[2], fields[3], fields[4]);
    if day == "*" && month == "*" && weekday == "*" {
        if minute == "*" && hour == "*" {
            return "Every minute".into();
        }
        if let Some(step) = minute.strip_prefix("*/") {
            if hour == "*" {
                return format!("Every {} minutes", step);
            }
        }
        if hour == "*" {
            if let Ok(value) = minute.parse::<u32>() {
                return format!("Every hour at :{:02}", value);
            }
        }
        if let (Ok(minute), Ok(hour)) = (minute.parse::<u32>(), hour.parse::<u32>()) {
            return format!("Every day at {}", format_time(hour, minute));
        }
    }
    if day == "*" && month == "*" {
        if let (Ok(minute), Ok(hour), Some(day_name)) = (
            minute.parse::<u32>(),
            hour.parse::<u32>(),
            weekday_name(weekday),
        ) {
            return format!("Every {} at {}", day_name, format_time(hour, minute));
        }
    }
    "Cron schedule".into()
}

fn format_time(hour: u32, minute: u32) -> String {
    let suffix = if hour < 12 { "AM" } else { "PM" };
    let display_hour = match hour % 12 {
        0 => 12,
        value => value,
    };
    format!("{}:{:02} {}", display_hour, minute, suffix)
}

fn weekday_name(value: &str) -> Option<&'static str> {
    match value {
        "0" | "7" => Some("Sunday"),
        "1" => Some("Monday"),
        "2" => Some("Tuesday"),
        "3" => Some("Wednesday"),
        "4" => Some("Thursday"),
        "5" => Some("Friday"),
        "6" => Some("Saturday"),
        _ => None,
    }
}

fn generate_task_id(now: chrono::DateTime<Utc>) -> String {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", now.format("%Y-%m-%d-%H%M"), &suffix[..4])
}

fn slugify(title: &str) -> String {
    let mut output = String::with_capacity(title.len());
    let mut last_dash = true;
    for character in title.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character);
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    output.trim_matches('-').chars().take(50).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_common_cron_schedules() {
        assert_eq!(describe_cron("*/5 * * * *"), "Every 5 minutes");
        assert_eq!(describe_cron("7 * * * *"), "Every hour at :07");
        assert_eq!(describe_cron("0 8 * * *"), "Every day at 8:00 AM");
        assert_eq!(describe_cron("30 18 * * 1"), "Every Monday at 6:30 PM");
    }

    #[test]
    fn slug_is_bounded() {
        assert_eq!(slugify("Monday Sailing Outlook"), "monday-sailing-outlook");
        assert_eq!(slugify(&"a".repeat(80)).len(), 50);
    }

    fn sample_task() -> ScheduledTask {
        ScheduledTask {
            id: "task-1".into(),
            created: "2026-01-01T00:00:00.000Z".into(),
            updated: "2026-01-01T00:00:00.000Z".into(),
            title: "Old title".into(),
            model: "mlx/old".into(),
            enabled: true,
            email: false,
            prompt: "Old prompt".into(),
            schedule: TaskSchedule {
                cron: "0 8 * * *".into(),
                timezone: "America/Los_Angeles".into(),
            },
            trigger: Some(TaskTrigger {
                condition: "Something changed".into(),
            }),
            last_scheduled_at: Some("2026-01-02T16:00:00.000Z".into()),
            last_run_at: Some("2026-01-02T16:00:01.000Z".into()),
            last_delivered_at: Some("2026-01-02T16:00:02.000Z".into()),
            history: Some(vec![crate::tasks::model::TaskAttempt {
                timestamp: "2026-01-02T16:00:02.000Z".into(),
                result: crate::tasks::model::TaskVerdict::Completed,
                reasoning: "Delivered".into(),
                error: None,
                usage: None,
            }]),
            messages: vec![serde_yaml::Value::String("preserve me".into())],
            extra: Mapping::new(),
        }
    }

    #[test]
    fn partial_update_preserves_results_and_clears_condition() {
        let mut task = sample_task();
        let original_messages = task.messages.clone();
        let input = serde_json::json!({
            "task_id": "task-1",
            "prompt": "Read private/obsidian_vault/Finance.md",
            "trigger_condition": "",
            "email": true
        });

        let changed = apply_updates(&mut task, &input, "2026-02-01T00:00:00.000Z").unwrap();

        assert_eq!(task.prompt, "Read private/obsidian_vault/Finance.md");
        assert!(task.trigger.is_none());
        assert!(task.email);
        let history = task.history.as_ref().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].reasoning, "Delivered");
        assert_eq!(task.messages, original_messages);
        assert_eq!(task.schedule.cron, "0 8 * * *");
        assert_eq!(changed, vec!["prompt", "email", "delivery condition"]);
    }

    #[test]
    fn schedule_update_validates_and_resets_baseline() {
        let mut task = sample_task();
        apply_updates(
            &mut task,
            &serde_json::json!({"task_id": "task-1", "cron": "30 6 * * *"}),
            "2026-02-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(task.schedule.cron, "30 6 * * *");
        assert_eq!(
            task.last_scheduled_at.as_deref(),
            Some("2026-02-01T00:00:00.000Z")
        );

        let error = apply_updates(
            &mut task,
            &serde_json::json!({"task_id": "task-1", "cron": "0 0 8 * * *"}),
            "2026-02-01T00:00:01.000Z",
        )
        .unwrap_err();
        assert!(error.contains("exactly five fields"));
    }

    #[tokio::test]
    async fn update_tool_persists_partial_change() {
        use std::sync::Arc;

        let temp = tempfile::tempdir().unwrap();
        let tasks_dir = temp.path().join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        let path = tasks_dir.join("task-1-old-title.yaml");
        crate::tasks::model::write_atomic(&path, &sample_task())
            .await
            .unwrap();
        let registry = Arc::new(ToolRegistry::new(
            Arc::new(crate::config::Config::default()),
            Arc::new(crate::vault::Vault::new(temp.path().to_path_buf()).unwrap()),
            crate::providers::ProviderRegistry::from_configs(&[]),
            Arc::new(crate::skill_registry::SkillRegistry::new()),
        ));

        let result = execute_update(
            &registry,
            &serde_json::json!({
                "task_id": "task-1",
                "prompt": "Updated prompt",
                "enabled": false
            }),
        )
        .await
        .unwrap();
        let saved = crate::tasks::model::load_one(&path).await.unwrap();

        assert!(result.contains("Changed: prompt, enabled"));
        assert_eq!(saved.prompt, "Updated prompt");
        assert!(!saved.enabled);
        assert_eq!(saved.history.as_ref().unwrap().len(), 1);
        assert_eq!(saved.messages.len(), 1);
    }
}
