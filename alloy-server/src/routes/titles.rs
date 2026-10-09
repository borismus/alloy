//! `/api/conversations/{id}/title-suggestions`: three alternative titles for
//! the rename dialog, generated from the conversation so far.
//!
//! Uses the model that wrote the conversation's last reply (falling back to the
//! conversation's model before any reply). The content only goes to a model
//! that has already seen it, so a local conversation stays local; a default
//! cloud model would not give that guarantee. A conversation marked as holding
//! private material is refused unless that model is local.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::json;
use serde_yaml::Value;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/conversations/{id}/title-suggestions",
        post(suggest_handler),
    )
}

/// Asks for four so one can be dropped (a repeat of the current title, a
/// duplicate) and three still remain.
const SYSTEM: &str = "Suggest four alternative titles for the conversation below. \
Each title is 3 to 7 words, specific to what the conversation is actually about, \
and takes a different angle from the others. If a current title is given, every \
suggestion must differ from it. Reply with exactly four lines, one title per line, \
with no numbering, quotes, or commentary.";

/// Characters of conversation sent to the model. Titles need the gist, not the
/// whole thread, and a small prompt keeps this fast and cheap.
const EXCERPT_CHARS: usize = 8_000;
const MESSAGE_CHARS: usize = 1_200;
/// The opening exchange says what the conversation set out to do; the latest
/// turns say where it went.
const OPENING_MESSAGES: usize = 2;
const RECENT_MESSAGES: usize = 6;

async fn suggest_handler(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match suggest(&state, &id).await {
        Ok(titles) => Json(json!({ "titles": titles })).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn suggest(state: &AppState, id: &str) -> Result<Vec<String>, (StatusCode, String)> {
    let not_found = || (StatusCode::NOT_FOUND, format!("Conversation {id} not found"));
    let path = crate::vault_writer::find_conversation_file(&state.vault, id)
        .await
        .map_err(|_| not_found())?;
    let text = tokio::fs::read_to_string(&path).await.map_err(|_| not_found())?;
    let doc: Value = serde_yaml::from_str(&text).map_err(|_| not_found())?;

    let model = last_used_model(&doc);
    let private = doc.get("private").and_then(Value::as_bool).unwrap_or(false);
    if private && !crate::local::model_is_local(&state.config, &model) {
        return Err((
            StatusCode::CONFLICT,
            "This conversation holds private material, so titles can only be suggested by a local model. Switch it to a local model first.".into(),
        ));
    }

    let excerpt = build_excerpt(doc.get("messages").and_then(Value::as_sequence));
    if excerpt.is_empty() {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, "Nothing to title yet.".into()));
    }
    let (provider, upstream) = state
        .providers
        .resolve(&model)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    // The current title comes from the file, so the dialog needn't send it.
    let current_title = doc
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let prompt = match current_title {
        Some(title) => format!("Current title: {title}\n\n{excerpt}"),
        None => excerpt,
    };
    let raw = provider
        .complete_once(SYSTEM, &prompt, upstream, 200)
        .await
        .ok_or_else(|| (StatusCode::BAD_GATEWAY, "The model didn't return suggestions.".into()))?;
    let titles = parse_titles(&raw, current_title);
    if titles.is_empty() {
        return Err((StatusCode::BAD_GATEWAY, "The model didn't return usable titles.".into()));
    }
    Ok(titles)
}

/// The model behind the latest assistant reply, or the conversation's model if
/// nothing has replied yet.
fn last_used_model(doc: &Value) -> String {
    doc.get("messages")
        .and_then(Value::as_sequence)
        .and_then(|messages| {
            messages.iter().rev().find_map(|m| {
                (m.get("role")?.as_str()? == "assistant")
                    .then(|| m.get("model")?.as_str())
                    .flatten()
                    .filter(|model| !model.is_empty())
            })
        })
        .or_else(|| doc.get("model").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// A labeled transcript of the opening and most recent user/assistant turns,
/// each message truncated, the whole capped at [`EXCERPT_CHARS`].
fn build_excerpt(messages: Option<&Vec<Value>>) -> String {
    let turns: Vec<(&str, &str)> = messages
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let role = match m.get("role")?.as_str()? {
                "user" => "User",
                "assistant" => "Assistant",
                _ => return None,
            };
            let content = m.get("content")?.as_str()?.trim();
            (!content.is_empty()).then_some((role, content))
        })
        .collect();

    let picked: Vec<&(&str, &str)> = if turns.len() <= OPENING_MESSAGES + RECENT_MESSAGES {
        turns.iter().collect()
    } else {
        turns[..OPENING_MESSAGES]
            .iter()
            .chain(&turns[turns.len() - RECENT_MESSAGES..])
            .collect()
    };

    let mut out = String::new();
    for (role, content) in picked {
        let clipped: String = content.chars().take(MESSAGE_CHARS).collect();
        let block = format!("{role}: {clipped}\n\n");
        if out.chars().count() + block.chars().count() > EXCERPT_CHARS {
            break;
        }
        out.push_str(&block);
    }
    out.trim_end().to_string()
}

/// Up to three clean, distinct titles from the model's reply, tolerating the
/// numbering, bullets, quotes, and reasoning blocks models add despite asking.
/// A suggestion matching the current title is dropped: offering it back is
/// useless, and models do it despite being told not to.
fn parse_titles(raw: &str, current_title: Option<&str>) -> Vec<String> {
    let stripped = crate::providers::strip_think_blocks(raw);
    let mut titles: Vec<String> = Vec::new();
    for line in stripped.lines() {
        let title = line
            .trim()
            .trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | '•'))
            .trim()
            .trim_matches(|c: char| matches!(c, '"' | '\'' | '*' | '#' | '“' | '”'))
            .trim()
            .to_string();
        let words = title.split_whitespace().count();
        if title.is_empty() || words > 12 || title.ends_with(':') {
            continue;
        }
        if current_title.is_some_and(|current| current.eq_ignore_ascii_case(&title)) {
            continue;
        }
        if !titles.iter().any(|t| t.eq_ignore_ascii_case(&title)) {
            titles.push(title);
        }
        if titles.len() == 3 {
            break;
        }
    }
    titles
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(pairs: &[(&str, &str)]) -> Vec<Value> {
        pairs
            .iter()
            .map(|(role, content)| {
                serde_yaml::from_str(&format!("role: {role}\ncontent: \"{content}\"")).unwrap()
            })
            .collect()
    }

    #[test]
    fn uses_the_model_of_the_latest_reply() {
        let doc: Value = serde_yaml::from_str(
            "model: openrouter/openai/gpt-6\nmessages:\n- role: user\n  content: hi\n- role: assistant\n  model: mlx/Qwen\n  content: a\n- role: assistant\n  model: claude-cli/opus\n  content: b\n- role: user\n  content: next\n",
        )
        .unwrap();
        assert_eq!(last_used_model(&doc), "claude-cli/opus");

        let fresh: Value =
            serde_yaml::from_str("model: mlx/Qwen\nmessages:\n- role: user\n  content: hi\n").unwrap();
        assert_eq!(last_used_model(&fresh), "mlx/Qwen");
    }

    #[test]
    fn excerpt_keeps_the_opening_and_recent_turns() {
        let mut pairs = vec![("user", "OPENING question"), ("assistant", "OPENING answer")];
        for i in 0..20 {
            pairs.push(("user", if i == 10 { "MIDDLE turn" } else { "filler" }));
        }
        pairs.push(("assistant", "LATEST answer"));
        pairs.insert(1, ("log", "Switched model"));
        let excerpt = build_excerpt(Some(&msgs(&pairs)));
        assert!(excerpt.starts_with("User: OPENING question"), "{excerpt}");
        assert!(excerpt.contains("Assistant: OPENING answer"));
        assert!(excerpt.ends_with("Assistant: LATEST answer"));
        assert!(!excerpt.contains("MIDDLE turn"));
        assert!(!excerpt.contains("Switched model"), "log messages are left out");
    }

    #[test]
    fn excerpt_is_capped() {
        let long = "x".repeat(5_000);
        let pairs: Vec<(&str, &str)> = (0..8).map(|_| ("user", long.as_str())).collect();
        let excerpt = build_excerpt(Some(&msgs(&pairs)));
        assert!(excerpt.chars().count() <= EXCERPT_CHARS);
        assert!(!excerpt.is_empty());
    }

    #[test]
    fn empty_conversations_have_no_excerpt() {
        assert_eq!(build_excerpt(None), "");
        assert_eq!(build_excerpt(Some(&msgs(&[("log", "hi")]))), "");
    }

    #[test]
    fn titles_are_cleaned_and_deduplicated() {
        let raw = "<think>pondering</think>\nHere are three titles:\n1. \"Exiting a Property Management Contract\"\n2) **Costs of Leaving Your Property Manager**\n- exiting a property management contract\n• Termination Fees and Notice Periods\n4. One too many";
        assert_eq!(
            parse_titles(raw, None),
            vec![
                "Exiting a Property Management Contract",
                "Costs of Leaving Your Property Manager",
                "Termination Fees and Notice Periods",
            ]
        );
    }

    #[test]
    fn rambling_lines_are_not_titles() {
        let raw = "I think the best title would capture the overall sense of what we discussed today in detail\nShort Title";
        assert_eq!(parse_titles(raw, None), vec!["Short Title"]);
    }

    #[test]
    fn the_current_title_is_never_suggested_back() {
        let raw = "Choosing a UPS for Synology NAS\nCyberPower ST625U vs CP900AVR Showdown\nchoosing a ups for synology nas\nSmall UPS Sizes and USB Data Ports";
        assert_eq!(
            parse_titles(raw, Some("Choosing a UPS for Synology NAS")),
            vec!["CyberPower ST625U vs CP900AVR Showdown", "Small UPS Sizes and USB Data Ports"]
        );
    }
}
