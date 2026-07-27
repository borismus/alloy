//! `/api/config` endpoints.
//!
//! Rust is the single config parser. The SPA reads its resolved, redacted
//! config here (never parsing config.yaml itself) and posts structured edits,
//! so the two sides can't drift. Writes are comment-preserving line splices,
//! mirroring what the SPA used to do in `vault.ts`.

use axum::{Json, Router, extract::State, routing::{get, put}};
use serde::{Deserialize, Serialize};

use crate::config::{ProviderKind, RawConfig};
use crate::{AppState, error::AppError, local};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/config", get(get_config))
        .route("/api/config/favorites", put(put_favorites))
        .route("/api/config/value", put(put_value))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientProvider {
    id: String,
    kind: &'static str,
    /// Resolved locality (via `local::provider_is_local`) so the SPA doesn't
    /// re-derive it.
    local: bool,
}

/// Config shape the SPA consumes. Provider API keys are omitted (the SPA only
/// checks provider presence); `sonioxApiKey` is included because the SPA runs
/// Soniox dictation client-side.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    version: Option<u32>,
    default_model: Option<String>,
    favorite_models: Vec<String>,
    external_editor: Option<String>,
    soniox_api_key: Option<String>,
    providers: Vec<ClientProvider>,
}

fn kind_str(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::OpenaiCompatible => "openai_compatible",
        ProviderKind::CliClaude => "cli_claude",
        ProviderKind::CliCodex => "cli_codex",
    }
}

async fn get_config(State(state): State<AppState>) -> Result<Json<Option<ClientConfig>>, AppError> {
    let path = state.vault.resolve("config.yaml")?;
    if !path.exists() {
        return Ok(Json(None));
    }
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Internal(format!("read config.yaml: {e}")))?;
    // A legacy or unparseable config → None, so the SPA shows onboarding rather
    // than a broken half-state. (The Rust model layer's `Config::load` fails
    // loudly on legacy configs at startup; this endpoint stays lenient.)
    let raw: RawConfig = match serde_yaml::from_str(&text) {
        Ok(raw) => raw,
        Err(_) => return Ok(Json(None)),
    };
    let providers = raw
        .providers
        .unwrap_or_default()
        .iter()
        .map(|p| ClientProvider {
            id: p.id.clone(),
            kind: kind_str(p.kind),
            local: local::provider_is_local(p),
        })
        .collect();
    Ok(Json(Some(ClientConfig {
        version: raw.version,
        default_model: raw.default_model,
        favorite_models: raw.favorite_models.unwrap_or_default(),
        external_editor: raw.external_editor,
        soniox_api_key: raw.soniox_api_key,
        providers,
    })))
}

#[derive(Deserialize)]
struct FavoritesReq {
    keys: Vec<String>,
}

async fn put_favorites(
    State(state): State<AppState>,
    Json(req): Json<FavoritesReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let path = state.vault.resolve("config.yaml")?;
    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let next = splice_favorites_block(&existing, &render_favorites_block(&req.keys));
    tokio::fs::write(&path, next.as_bytes())
        .await
        .map_err(|e| AppError::Internal(format!("write config.yaml: {e}")))?;
    Ok(Json(serde_json::json!({})))
}

#[derive(Deserialize)]
struct ValueReq {
    key: String,
    value: String,
}

async fn put_value(
    State(state): State<AppState>,
    Json(req): Json<ValueReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let path = state.vault.resolve("config.yaml")?;
    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let next = splice_scalar(&existing, &req.key, &req.value);
    tokio::fs::write(&path, next.as_bytes())
        .await
        .map_err(|e| AppError::Internal(format!("write config.yaml: {e}")))?;
    Ok(Json(serde_json::json!({})))
}

// --- Comment-preserving YAML line splices (ported from the SPA's vault.ts) ---

fn render_favorites_block(keys: &[String]) -> String {
    if keys.is_empty() {
        return "favoriteModels: []\n".to_string();
    }
    let lines: Vec<String> = keys.iter().map(|k| format!("  - {k}")).collect();
    format!("favoriteModels:\n{}\n", lines.join("\n"))
}

/// Replace the `favoriteModels:` block in raw YAML with `block`, consuming only
/// the following list-item lines so surrounding comments/keys survive.
fn splice_favorites_block(existing: &str, block: &str) -> String {
    if existing.trim().is_empty() {
        return block.to_string();
    }
    let lines: Vec<&str> = existing.split('\n').collect();
    let Some(start) = lines.iter().position(|l| l.starts_with("favoriteModels:")) else {
        // Prepend at the top — favorites live alongside defaultModel.
        return format!("{block}{existing}");
    };
    let mut end = start + 1;
    for line in lines.iter().skip(start + 1) {
        if line.trim_start().starts_with('-') {
            end += 1;
        } else {
            break;
        }
    }
    let before = lines[..start].join("\n");
    let after = lines[end..].join("\n");
    let before_part = if before.is_empty() {
        String::new()
    } else {
        format!("{before}\n")
    };
    format!("{before_part}{block}{after}")
}

/// Replace a top-level `key: value` line, preserving every other line; append
/// the key if absent.
fn splice_scalar(existing: &str, key: &str, value: &str) -> String {
    let line = format!("{key}: {value}");
    if existing.trim().is_empty() {
        return format!("{line}\n");
    }
    let prefix = format!("{key}:");
    let mut lines: Vec<String> = existing.split('\n').map(String::from).collect();
    for l in lines.iter_mut() {
        if l.starts_with(&prefix) {
            *l = line.clone();
            return lines.join("\n");
        }
    }
    let sep = if existing.ends_with('\n') { "" } else { "\n" };
    format!("{existing}{sep}{line}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_favorites_block() {
        assert_eq!(render_favorites_block(&[]), "favoriteModels: []\n");
        assert_eq!(
            render_favorites_block(&["a/b".into(), "c/d".into()]),
            "favoriteModels:\n  - a/b\n  - c/d\n"
        );
    }

    #[test]
    fn splices_favorites_preserving_surrounding_lines() {
        let existing = "version: 1\nfavoriteModels:\n  - old/one\ndefaultModel: x\n# a comment\n";
        let next = splice_favorites_block(&existing, &render_favorites_block(&["new/a".into()]));
        assert!(next.contains("favoriteModels:\n  - new/a\n"));
        assert!(next.contains("defaultModel: x"));
        assert!(next.contains("# a comment"));
        assert!(!next.contains("old/one"));
    }

    #[test]
    fn prepends_favorites_when_absent() {
        let existing = "version: 1\ndefaultModel: x\n";
        let next = splice_favorites_block(&existing, &render_favorites_block(&["a/b".into()]));
        assert!(next.starts_with("favoriteModels:\n  - a/b\n"));
        assert!(next.contains("defaultModel: x"));
    }

    #[test]
    fn splices_scalar_in_place_and_appends() {
        let existing = "version: 1\nexternalEditor: obsidian\n# keep me\n";
        let next = splice_scalar(existing, "externalEditor", "system");
        assert!(next.contains("externalEditor: system"));
        assert!(next.contains("# keep me"));
        assert!(!next.contains("externalEditor: obsidian"));

        let appended = splice_scalar("version: 1\n", "externalEditor", "system");
        assert!(appended.contains("version: 1"));
        assert!(appended.contains("externalEditor: system"));
    }
}
