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
    Ok(format!(
        "Created scheduled task \"{}\" (id: {}). Schedule: {} (`{}`, {}). Next run: {}. It is {}.",
        title,
        id,
        describe_cron(cron_expression),
        cron_expression,
        timezone,
        next,
        kind,
    ))
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
}
