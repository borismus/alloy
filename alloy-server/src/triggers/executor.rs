//! Run a trigger once: build the baseline-or-monitor system prompt,
//! drive `streaming::run_to_completion`, parse the JSON verdict.
//!
//! Mirrors [src/services/triggers/executor.ts](src/services/triggers/executor.ts).

use chrono::Utc;
use regex::Regex;
use serde_yaml::Value;

use crate::providers::WireMessage;
use crate::streaming::{StartParams, run_to_completion};
use crate::triggers::model::{Trigger, TriggerRunOutcome, TriggerVerdict};
use crate::AppState;

/// Mirrors `MAX_BASELINE_CHARS` from executor.ts.
const MAX_BASELINE_CHARS: usize = 14_000;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn baseline_system_prompt() -> String {
    let now = Utc::now();
    format!(
        "You are a trigger evaluation system establishing a baseline for future monitoring.\n\n\
         Current time: {} UTC\n\n\
         This is a BASELINE ESTABLISHMENT run. Your job is to gather the current state of what's being monitored so that future checks can detect changes.\n\n\
         You have access to tools like web_search to gather real-time information. Use them as needed.\n\n\
         IMPORTANT: Always gather and report the current data. Include specific data points (numbers, prices, percentages, timestamps, etc.) so future checks can detect meaningful changes.\n\n\
         Always end your response with:\n```json\n{{\"triggered\": true}}\n```\n\n\
         Your response will be saved as the baseline for future comparison.",
        now.format("%Y-%m-%d %H:%M")
    )
}

fn monitor_system_prompt() -> String {
    let now = Utc::now();
    format!(
        "You are a trigger evaluation system that monitors conditions and notifies the user when they're met.\n\n\
         Current time: {} UTC\n\n\
         A BASELINE from your last notification is provided below.\n\
         The baseline is your last assistant message from when you previously triggered.\n\
         Only trigger if the current state has MEANINGFULLY CHANGED from this baseline.\n\
         Do NOT re-trigger for the same condition that was already reported.\n\
         Compare the current data against the baseline to detect changes.\n\
         If no baseline is available, gather the current state and report it — your response will become the baseline for future comparisons.\n\n\
         You have access to tools like web_search to gather real-time information. Use them as needed.\n\n\
         Your response format depends on whether you should trigger:\n\n\
         IF TRIGGERING (condition met / changed meaningfully):\n\
         Provide a helpful, informative response to the user about the current state.\n\
         Include specific data points (numbers, prices, percentages, etc.) that are relevant.\n\
         End your response with a JSON block:\n```json\n{{\"triggered\": true}}\n```\n\n\
         IF NOT TRIGGERING (condition not met / no meaningful change):\n\
         End with a JSON block explaining why:\n```json\n{{\"triggered\": false, \"reason\": \"brief explanation\"}}\n```\n\n\
         You MUST end with the JSON block. Any text before it will be shown to the user if triggered.",
        now.format("%Y-%m-%d %H:%M")
    )
}

/// Find the latest assistant baseline from the trigger's message history.
/// Matches the TS `extractBaseline` logic: assistant message whose timestamp
/// equals `lastTriggered`.
fn extract_baseline(trigger: &Trigger) -> Option<String> {
    let last_triggered = trigger.last_triggered.as_deref()?;
    for msg in &trigger.messages {
        let m = msg.as_mapping()?;
        let role = m.get(Value::String("role".into()))?.as_str()?;
        if role != "assistant" {
            continue;
        }
        let ts = m.get(Value::String("timestamp".into()))?.as_str()?;
        if ts == last_triggered {
            return m
                .get(Value::String("content".into()))?
                .as_str()
                .map(|s| s.to_string());
        }
    }
    None
}

/// Run the trigger once. Returns the verdict and (for `triggered`) the
/// user-facing response. Does NOT write anything to disk — the caller is
/// responsible for applying the outcome to the trigger YAML.
pub async fn run(trigger: &Trigger, state: &AppState) -> TriggerRunOutcome {
    let is_baseline = trigger.last_triggered.is_none();

    let mut messages: Vec<WireMessage> = Vec::new();
    if !is_baseline {
        if let Some(baseline) = extract_baseline(trigger) {
            let truncated = if baseline.len() > MAX_BASELINE_CHARS {
                format!("{}\n…[truncated]", &baseline[..MAX_BASELINE_CHARS])
            } else {
                baseline
            };
            messages.push(WireMessage {
                id: None,
                role: "user".into(),
                content: format!("BASELINE (from your last notification):\n\n{}", truncated),
                attachments: Vec::new(),
            });
            messages.push(WireMessage {
                id: None,
                role: "assistant".into(),
                content: "I will compare the current state against this baseline and only trigger if there is a meaningful change.".into(),
                attachments: Vec::new(),
            });
        }
    }
    messages.push(WireMessage {
        id: None,
        role: "user".into(),
        content: trigger.trigger_prompt.clone(),
        attachments: Vec::new(),
    });

    let system_prompt = if is_baseline {
        baseline_system_prompt()
    } else {
        monitor_system_prompt()
    };

    let session_id = format!("trigger-{}-{}", trigger.id, Utc::now().timestamp_millis());
    let params = StartParams {
        session_id,
        // The trigger id doubles as the "conversation id" for logging
        // purposes only — skip_persist=true means no conversation YAML lookup.
        conversation_id: trigger.id.clone(),
        assistant_message_id: None,
        model: trigger.model.clone(),
        messages,
        system_prompt: Some(system_prompt),
        is_first_message: false,
        user_message_content: trigger.trigger_prompt.clone(),
        invoke_skill: None,
        skip_persist: true,
    };

    let outcome = run_to_completion(
        &state.sessions,
        state.providers.clone(),
        state.vault.clone(),
        state.tools.clone(),
        state.model_cache.clone(),
        state.config.compaction,
        params,
    )
    .await;

    match outcome {
        Ok(session_outcome) => {
            let usage_value = session_outcome
                .usage
                .as_ref()
                .and_then(|u| serde_yaml::to_value(u).ok());
            parse_response(&session_outcome.content, usage_value)
        }
        Err(e) => TriggerRunOutcome {
            result: TriggerVerdict::Error,
            response: String::new(),
            error: Some(e.to_string()),
            usage: None,
        },
    }
}

/// Mirrors the `parseResponse` regex/JSON logic in executor.ts.
/// Looks for a trailing ```json {...} ``` block (or a bare `{"triggered": ...}`)
/// and returns the parsed verdict. Anything before the JSON block becomes
/// the user-facing response for a `triggered` verdict.
pub fn parse_response(content: &str, usage: Option<Value>) -> TriggerRunOutcome {
    // Code block: ```json? { ... } ``` at the end of the message.
    let block_re = Regex::new(r"(?s)```(?:json)?\s*(\{.*?\})\s*```\s*$").unwrap();
    // Bare object at end of message containing "triggered".
    let bare_re = Regex::new(r#"(?s)\{[^{}]*"triggered"[^{}]*\}\s*$"#).unwrap();

    let (json_str, strip_re) = if let Some(caps) = block_re.captures(content) {
        (caps.get(1).unwrap().as_str().to_string(), block_re.clone())
    } else if let Some(m) = bare_re.find(content) {
        (m.as_str().to_string(), bare_re.clone())
    } else {
        let tail = if content.len() > 200 {
            &content[content.len() - 200..]
        } else {
            content
        };
        return TriggerRunOutcome {
            result: TriggerVerdict::Error,
            response: String::new(),
            error: Some(format!("No JSON verdict found in response: \"{}\"", tail)),
            usage,
        };
    };

    let parsed: serde_json::Value = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(e) => {
            return TriggerRunOutcome {
                result: TriggerVerdict::Error,
                response: String::new(),
                error: Some(format!("Parse error: {}", e)),
                usage,
            };
        }
    };

    let triggered = match parsed.get("triggered").and_then(|v| v.as_bool()) {
        Some(b) => b,
        None => {
            return TriggerRunOutcome {
                result: TriggerVerdict::Error,
                response: String::new(),
                error: Some("Invalid response: triggered must be boolean".into()),
                usage,
            };
        }
    };

    if triggered {
        let stripped = strip_re.replace(content, "").trim().to_string();
        let response = if stripped.is_empty() {
            "Condition met.".to_string()
        } else {
            stripped
        };
        TriggerRunOutcome {
            result: TriggerVerdict::Triggered,
            response,
            error: None,
            usage,
        }
    } else {
        let reason = parsed
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("Condition not met")
            .to_string();
        TriggerRunOutcome {
            result: TriggerVerdict::Skipped,
            response: reason,
            error: None,
            usage,
        }
    }
}

/// Used by the scheduler to update the trigger YAML after a run. Returns
/// the timestamp it wrote so callers can include it in logs.
pub fn apply_outcome(trigger: &mut Trigger, outcome: &TriggerRunOutcome) -> String {
    use crate::triggers::model::{TriggerAttempt, push_fire_messages, push_history};

    let now = now_iso();
    trigger.last_checked = Some(now.clone());

    match outcome.result {
        TriggerVerdict::Triggered => {
            push_fire_messages(
                trigger,
                &trigger.trigger_prompt.clone(),
                &outcome.response,
                &trigger.model.clone(),
                outcome.usage.as_ref(),
                &now,
            );
            trigger.last_triggered = Some(now.clone());
            trigger.updated = now.clone();
            let reasoning = outcome.response.chars().take(200).collect();
            push_history(
                trigger,
                TriggerAttempt {
                    timestamp: now.clone(),
                    result: TriggerVerdict::Triggered,
                    reasoning,
                    error: None,
                    usage: outcome.usage.clone(),
                },
            );
        }
        TriggerVerdict::Skipped => {
            push_history(
                trigger,
                TriggerAttempt {
                    timestamp: now.clone(),
                    result: TriggerVerdict::Skipped,
                    reasoning: outcome.response.clone(),
                    error: None,
                    usage: outcome.usage.clone(),
                },
            );
        }
        TriggerVerdict::Error => {
            push_history(
                trigger,
                TriggerAttempt {
                    timestamp: now.clone(),
                    result: TriggerVerdict::Error,
                    reasoning: String::new(),
                    error: outcome.error.clone(),
                    usage: outcome.usage.clone(),
                },
            );
        }
    }

    now
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_triggered_with_code_block() {
        let content = "Bitcoin is at $50k.\n\n```json\n{\"triggered\": true}\n```";
        let o = parse_response(content, None);
        assert_eq!(o.result, TriggerVerdict::Triggered);
        assert_eq!(o.response, "Bitcoin is at $50k.");
    }

    #[test]
    fn parses_skipped_with_reason() {
        let content = "```json\n{\"triggered\": false, \"reason\": \"no change\"}\n```";
        let o = parse_response(content, None);
        assert_eq!(o.result, TriggerVerdict::Skipped);
        assert_eq!(o.response, "no change");
    }

    #[test]
    fn parses_bare_json() {
        let content = "Stuff happened.\n{\"triggered\": true}";
        let o = parse_response(content, None);
        assert_eq!(o.result, TriggerVerdict::Triggered);
        assert!(o.response.contains("Stuff happened."));
    }

    #[test]
    fn errors_without_json() {
        let content = "Just plain text with no verdict block";
        let o = parse_response(content, None);
        assert_eq!(o.result, TriggerVerdict::Error);
        assert!(o.error.is_some());
    }

    #[test]
    fn errors_on_non_bool_triggered() {
        let content = "```json\n{\"triggered\": \"yes\"}\n```";
        let o = parse_response(content, None);
        assert_eq!(o.result, TriggerVerdict::Error);
    }
}
