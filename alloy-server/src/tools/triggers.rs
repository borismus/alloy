//! `create_trigger` tool: model-callable shortcut for spawning a new
//! recurring monitor without forcing the model to hand-roll a YAML via
//! `write_file`.
//!
//! Writes a fresh `vault/triggers/<id>-<slug>.yaml`. The background
//! scheduler picks the new file up on its next tick (≤60 s) and runs the
//! baseline pass — no manual kick-off needed.

use chrono::Utc;
use serde_json::Value;
use serde_yaml::Mapping;
use tokio::fs;

use crate::tools::{ToolRegistry, input_string};
use crate::triggers::model::Trigger;

/// Default monitoring cadence when the model doesn't supply one. Triggers
/// run server-side so over-frequent monitors only burn tokens, not battery.
const DEFAULT_INTERVAL_MINUTES: u32 = 60;

pub async fn execute(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let title = input_string(input, "title")
        .ok_or_else(|| "create_trigger: missing 'title'".to_string())?
        .trim();
    let prompt = input_string(input, "trigger_prompt")
        .ok_or_else(|| "create_trigger: missing 'trigger_prompt'".to_string())?;
    if title.is_empty() {
        return Err("create_trigger: 'title' must not be empty".into());
    }
    if prompt.trim().is_empty() {
        return Err("create_trigger: 'trigger_prompt' must not be empty".into());
    }

    let interval_minutes = parse_interval(input).unwrap_or(DEFAULT_INTERVAL_MINUTES);
    if interval_minutes == 0 {
        return Err("create_trigger: 'interval_minutes' must be at least 1".into());
    }

    let model_id = match input_string(input, "model") {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => registry
            .config
            .default_model
            .clone()
            .ok_or_else(|| "create_trigger: no 'model' specified and config has no defaultModel".to_string())?,
    };

    let now = Utc::now();
    let id = generate_trigger_id(now);
    let slug = slugify(title);
    let filename = if slug.is_empty() {
        format!("{}.yaml", id)
    } else {
        format!("{}-{}.yaml", id, slug)
    };

    let triggers_dir = registry.vault.resolve("triggers").map_err(|e| e.to_string())?;
    fs::create_dir_all(&triggers_dir)
        .await
        .map_err(|e| format!("create_trigger: failed to create triggers dir: {}", e))?;

    let path = triggers_dir.join(&filename);
    if path.exists() {
        return Err(format!("create_trigger: file already exists: {}", filename));
    }

    let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let trigger = Trigger {
        id: id.clone(),
        created: now_iso.clone(),
        updated: now_iso,
        title: title.to_string(),
        model: model_id,
        enabled: true,
        trigger_prompt: prompt.to_string(),
        interval_minutes,
        last_checked: None,
        last_triggered: None,
        history: None,
        messages: Vec::new(),
        extra: Mapping::new(),
    };

    let yaml = serde_yaml::to_string(&trigger)
        .map_err(|e| format!("create_trigger: serialize failed: {}", e))?;
    fs::write(&path, yaml)
        .await
        .map_err(|e| format!("create_trigger: write failed: {}", e))?;

    Ok(format!(
        "Created trigger \"{}\" (id: {}, interval: {}m, enabled). The background scheduler will run the baseline pass within ~60 seconds — open the trigger from the sidebar to watch for the first response.",
        title, id, interval_minutes
    ))
}

fn parse_interval(input: &Value) -> Option<u32> {
    // Accept both a numeric and a string, since model JSON-schema coercion
    // is inconsistent across providers.
    if let Some(n) = input.get("interval_minutes").and_then(|v| v.as_u64()) {
        return u32::try_from(n).ok();
    }
    if let Some(s) = input_string(input, "interval_minutes") {
        return s.parse::<u32>().ok();
    }
    None
}

fn generate_trigger_id(now: chrono::DateTime<chrono::Utc>) -> String {
    // Matches the format used elsewhere: YYYY-MM-DD-HHMM-<4 hex chars>.
    let suffix: String = (0..4)
        .map(|_| {
            let n = rand_u8();
            std::char::from_digit((n % 16) as u32, 16).unwrap()
        })
        .collect();
    format!("{}-{}", now.format("%Y-%m-%d-%H%M"), suffix)
}

fn rand_u8() -> u8 {
    // Tiny RNG without pulling the rand crate — derive from current
    // nanosecond timestamp. Adequate for ID disambiguation, not cryptographic.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ (nanos >> 16)) as u8
}

fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').chars().take(50).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Watch BTC price"), "watch-btc-price");
        assert_eq!(slugify("  Mixed!! Punctuation??  "), "mixed-punctuation");
        let long = "a".repeat(80);
        assert_eq!(slugify(&long).len(), 50);
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn id_format_is_stable_shape() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 5, 25, 13, 7, 0).unwrap();
        let id = generate_trigger_id(now);
        assert!(id.starts_with("2026-05-25-1307-"));
        assert_eq!(id.len(), "YYYY-MM-DD-HHMM-XXXX".len());
    }

    #[test]
    fn parse_interval_accepts_number_and_string() {
        let n = serde_json::json!({"interval_minutes": 30});
        assert_eq!(parse_interval(&n), Some(30));
        let s = serde_json::json!({"interval_minutes": "45"});
        assert_eq!(parse_interval(&s), Some(45));
        let none = serde_json::json!({});
        assert_eq!(parse_interval(&none), None);
    }

    use chrono::TimeZone;
}
