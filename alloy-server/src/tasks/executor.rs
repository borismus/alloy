//! Execute scheduled tasks with optional conditional delivery.

use chrono::Utc;
use regex::Regex;
use serde_yaml::Value;

use crate::providers::WireMessage;
use crate::streaming::{run_to_completion, StartParams};
use crate::tasks::model::{ScheduledTask, TaskRunOutcome, TaskVerdict};
use crate::AppState;

const MAX_BASELINE_CHARS: usize = 14_000;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn unconditional_system_prompt() -> String {
    format!(
        "You are executing a scheduled task for the user.\n\n\
         Current time: {} UTC\n\n\
         Complete the task and return the useful result directly. You have access to tools; use them as needed. \
         This is an unattended scheduled run, so be concise, specific, and do not ask follow-up questions.",
        Utc::now().format("%Y-%m-%d %H:%M")
    )
}

fn conditional_system_prompt(condition: &str, has_baseline: bool) -> String {
    let baseline_guidance = if has_baseline {
        "The last delivered result is included in the conversation. Do not trigger again for substantially unchanged information. If the condition became false and is now true again, that is a new trigger."
    } else {
        "There is no previous delivered result. Evaluate the actual condition on this first run; do NOT trigger merely to establish a baseline."
    };
    format!(
        "You are executing a scheduled task with conditional delivery.\n\n\
         Current time: {} UTC\n\n\
         TRIGGER CONDITION:\n{}\n\n\
         Complete the task using tools as needed, then decide whether its result should be delivered.\n\
         {}\n\n\
         IF THE CONDITION IS MET and this is a useful new notification:\n\
         Write the user-facing result, then end with:\n```json\n{{\"triggered\": true}}\n```\n\n\
         IF THE CONDITION IS NOT MET or the result is a duplicate:\n\
         End with only a brief verdict block:\n```json\n{{\"triggered\": false, \"reason\": \"brief explanation\"}}\n```\n\n\
         You MUST end with one of those JSON blocks.",
        Utc::now().format("%Y-%m-%d %H:%M"),
        condition,
        baseline_guidance,
    )
}

fn extract_last_delivery(task: &ScheduledTask) -> Option<String> {
    let delivered_at = task.last_delivered_at.as_deref()?;
    task.messages.iter().find_map(|message| {
        let map = message.as_mapping()?;
        let role = map.get(Value::String("role".into()))?.as_str()?;
        let timestamp = map.get(Value::String("timestamp".into()))?.as_str()?;
        if role == "assistant" && timestamp == delivered_at {
            map.get(Value::String("content".into()))?
                .as_str()
                .map(str::to_string)
        } else {
            None
        }
    })
}

pub async fn run(task: &ScheduledTask, state: &AppState) -> TaskRunOutcome {
    let mut messages = Vec::new();
    let baseline = task
        .trigger
        .as_ref()
        .and_then(|_| extract_last_delivery(task));
    if let Some(value) = baseline.as_deref() {
        let truncated = truncate_chars(value, MAX_BASELINE_CHARS);
        messages.push(WireMessage {
            id: None,
            role: "user".into(),
            content: format!("LAST DELIVERED RESULT:\n\n{}", truncated),
            attachments: Vec::new(),
        });
        messages.push(WireMessage {
            id: None,
            role: "assistant".into(),
            content: "I will use this only to avoid duplicate notifications and will evaluate the current condition independently.".into(),
            attachments: Vec::new(),
        });
    }
    messages.push(WireMessage {
        id: None,
        role: "user".into(),
        content: task.prompt.clone(),
        attachments: Vec::new(),
    });

    let system_prompt = match task.trigger.as_ref() {
        Some(trigger) => conditional_system_prompt(&trigger.condition, baseline.is_some()),
        None => unconditional_system_prompt(),
    };
    let session_id = format!("task-{}-{}", task.id, Utc::now().timestamp_millis());
    let params = StartParams {
        session_id,
        conversation_id: task.id.clone(),
        assistant_message_id: None,
        model: task.model.clone(),
        messages,
        system_prompt: Some(system_prompt),
        is_first_message: false,
        user_message_content: task.prompt.clone(),
        invoke_skill: None,
        skip_persist: true,
    };

    match run_to_completion(
        &state.sessions,
        state.providers.clone(),
        state.vault.clone(),
        state.tools.clone(),
        state.model_cache.clone(),
        state.config.compaction,
        params,
    )
    .await
    {
        Ok(session_outcome) => {
            let usage = session_outcome
                .usage
                .as_ref()
                .and_then(|value| serde_yaml::to_value(value).ok());
            if task.trigger.is_some() {
                parse_conditional_response(&session_outcome.content, usage)
            } else {
                TaskRunOutcome {
                    result: TaskVerdict::Completed,
                    response: session_outcome.content.trim().to_string(),
                    error: None,
                    usage,
                }
            }
        }
        Err(error) => TaskRunOutcome {
            result: TaskVerdict::Error,
            response: String::new(),
            error: Some(error.to_string()),
            usage: None,
        },
    }
}

pub fn parse_conditional_response(content: &str, usage: Option<Value>) -> TaskRunOutcome {
    let block_re = Regex::new(r"(?s)```(?:json)?\s*(\{.*?\})\s*```\s*$").unwrap();
    let bare_re = Regex::new(r#"(?s)\{[^{}]*"triggered"[^{}]*\}\s*$"#).unwrap();

    let (json, strip_re) = if let Some(captures) = block_re.captures(content) {
        (
            captures.get(1).unwrap().as_str().to_string(),
            block_re.clone(),
        )
    } else if let Some(found) = bare_re.find(content) {
        (found.as_str().to_string(), bare_re.clone())
    } else {
        return TaskRunOutcome {
            result: TaskVerdict::Error,
            response: String::new(),
            error: Some(format!(
                "No JSON verdict found in response: \"{}\"",
                tail_chars(content, 200)
            )),
            usage,
        };
    };

    let parsed: serde_json::Value = match serde_json::from_str(&json) {
        Ok(value) => value,
        Err(error) => {
            return TaskRunOutcome {
                result: TaskVerdict::Error,
                response: String::new(),
                error: Some(format!("Parse error: {}", error)),
                usage,
            };
        }
    };
    let triggered = match parsed.get("triggered").and_then(|value| value.as_bool()) {
        Some(value) => value,
        None => {
            return TaskRunOutcome {
                result: TaskVerdict::Error,
                response: String::new(),
                error: Some("Invalid response: triggered must be boolean".into()),
                usage,
            };
        }
    };

    if triggered {
        let response = strip_re.replace(content, "").trim().to_string();
        TaskRunOutcome {
            result: TaskVerdict::Triggered,
            response: if response.is_empty() {
                "Condition met.".into()
            } else {
                response
            },
            error: None,
            usage,
        }
    } else {
        TaskRunOutcome {
            result: TaskVerdict::Skipped,
            response: parsed
                .get("reason")
                .and_then(|value| value.as_str())
                .unwrap_or("Condition not met")
                .to_string(),
            error: None,
            usage,
        }
    }
}

pub fn apply_outcome(task: &mut ScheduledTask, outcome: &TaskRunOutcome) -> String {
    use crate::tasks::model::{push_delivery_messages, push_history, TaskAttempt};

    let now = now_iso();
    task.last_run_at = Some(now.clone());
    task.updated = now.clone();

    match outcome.result {
        TaskVerdict::Completed | TaskVerdict::Triggered => {
            push_delivery_messages(task, &outcome.response, outcome.usage.as_ref(), &now);
            task.last_delivered_at = Some(now.clone());
            push_history(
                task,
                TaskAttempt {
                    timestamp: now.clone(),
                    result: outcome.result,
                    reasoning: outcome.response.chars().take(200).collect(),
                    error: None,
                    usage: outcome.usage.clone(),
                },
            );
        }
        TaskVerdict::Skipped => push_history(
            task,
            TaskAttempt {
                timestamp: now.clone(),
                result: TaskVerdict::Skipped,
                reasoning: outcome.response.clone(),
                error: None,
                usage: outcome.usage.clone(),
            },
        ),
        TaskVerdict::Error => push_history(
            task,
            TaskAttempt {
                timestamp: now.clone(),
                result: TaskVerdict::Error,
                reasoning: String::new(),
                error: outcome.error.clone(),
                usage: outcome.usage.clone(),
            },
        ),
    }
    now
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        format!(
            "{}\n…[truncated]",
            value.chars().take(max).collect::<String>()
        )
    }
}

fn tail_chars(value: &str, max: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    chars[chars.len().saturating_sub(max)..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::model::{TaskSchedule, TaskTrigger, TaskVerdict};
    use serde_yaml::Mapping;

    fn task(conditional: bool) -> ScheduledTask {
        ScheduledTask {
            id: "task".into(),
            created: "2026-07-20T00:00:00Z".into(),
            updated: "2026-07-20T00:00:00Z".into(),
            title: "Task".into(),
            model: "mlx/test".into(),
            enabled: true,
            email: false,
            prompt: "Do it".into(),
            schedule: TaskSchedule {
                cron: "0 8 * * *".into(),
                timezone: "UTC".into(),
            },
            trigger: conditional.then(|| TaskTrigger {
                condition: "When relevant".into(),
            }),
            last_scheduled_at: None,
            last_run_at: None,
            last_delivered_at: None,
            history: None,
            messages: vec![],
            extra: Mapping::new(),
        }
    }

    #[test]
    fn parses_triggered_response() {
        let outcome = parse_conditional_response(
            "Bitcoin crossed the threshold.\n```json\n{\"triggered\": true}\n```",
            None,
        );
        assert_eq!(outcome.result, TaskVerdict::Triggered);
        assert_eq!(outcome.response, "Bitcoin crossed the threshold.");
    }

    #[test]
    fn parses_skipped_response() {
        let outcome = parse_conditional_response(
            "```json\n{\"triggered\": false, \"reason\": \"still above threshold\"}\n```",
            None,
        );
        assert_eq!(outcome.result, TaskVerdict::Skipped);
        assert_eq!(outcome.response, "still above threshold");
    }

    #[test]
    fn missing_or_invalid_verdict_is_error() {
        assert_eq!(
            parse_conditional_response("plain response", None).result,
            TaskVerdict::Error
        );
        assert_eq!(
            parse_conditional_response("{\"triggered\": \"yes\"}", None).result,
            TaskVerdict::Error
        );
    }

    #[test]
    fn unconditional_text_does_not_need_verdict() {
        let outcome = TaskRunOutcome {
            result: TaskVerdict::Completed,
            response: "Daily report".into(),
            error: None,
            usage: None,
        };
        assert_eq!(outcome.result, TaskVerdict::Completed);
    }

    #[test]
    fn completed_and_triggered_outcomes_are_delivered() {
        for verdict in [TaskVerdict::Completed, TaskVerdict::Triggered] {
            let mut value = task(verdict == TaskVerdict::Triggered);
            apply_outcome(
                &mut value,
                &TaskRunOutcome {
                    result: verdict,
                    response: "Useful result".into(),
                    error: None,
                    usage: None,
                },
            );
            assert!(value.last_delivered_at.is_some());
            assert_eq!(value.messages.len(), 2);
            assert_eq!(value.history.as_ref().unwrap()[0].result, verdict);
        }
    }

    #[test]
    fn skipped_outcome_records_history_without_delivery() {
        let mut value = task(true);
        apply_outcome(
            &mut value,
            &TaskRunOutcome {
                result: TaskVerdict::Skipped,
                response: "Condition not met".into(),
                error: None,
                usage: None,
            },
        );
        assert!(value.last_delivered_at.is_none());
        assert!(value.messages.is_empty());
        assert_eq!(
            value.history.as_ref().unwrap()[0].result,
            TaskVerdict::Skipped
        );
    }
}
