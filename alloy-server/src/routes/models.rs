//! `GET /api/models` — aggregate model list across configured providers.
//!
//! Lets the SPA replace its bundled per-provider model lists with the live
//! source of truth. Results are cached for 1h to avoid hammering OpenRouter.
//!
//! Wire shape mirrors `ModelInfo` in [src/types/index.ts](src/types/index.ts):
//! `[{ key: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow?: 1000000 }, ...]`

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::{
    config::{CliAdapter, ProviderKind},
    providers::{cli_claude::CliClaudeProvider, cli_codex::CliCodexProvider, DiscoveredModel},
    AppState,
};

const CACHE_TTL: Duration = Duration::from_secs(3600);

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub key: String,
    pub name: String,
    /// Provider id this model came from (e.g. "mlx" or "openrouter").
    /// Lets the picker label every row unambiguously — two providers can serve
    /// a model with the same display name (e.g. "gemma4").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// True only when the provider is explicitly `local: true` and its endpoint
    /// is private-network, meaning the user trusts prompts to stay on-device/LAN.
    /// Drives the "Local" privacy badge in the picker.
    #[serde(default, skip_serializing_if = "is_false")]
    pub local: bool,
    #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// USD per million input tokens (when known). Sourced from OpenRouter's
    /// /models endpoint; absent for upstreams that don't report pricing.
    #[serde(rename = "inputPer1M", skip_serializing_if = "Option::is_none")]
    pub input_per_1m: Option<f64>,
    /// USD per million output tokens (when known).
    #[serde(rename = "outputPer1M", skip_serializing_if = "Option::is_none")]
    pub output_per_1m: Option<f64>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/models", get(list_models))
}

#[derive(Default)]
pub struct ModelCache {
    entry: Mutex<Option<(Instant, Vec<ModelInfo>)>>,
}

impl ModelCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self) -> Option<Vec<ModelInfo>> {
        let guard = self.entry.lock().unwrap();
        if let Some((at, models)) = guard.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Some(models.clone());
            }
        }
        None
    }

    fn set(&self, models: Vec<ModelInfo>) {
        *self.entry.lock().unwrap() = Some((Instant::now(), models));
    }

    /// Look up per-million-token pricing for a `<provider>/<upstream-model>`
    /// key. Falls back to `provider/upstream` prefix match for dated model
    /// ids (e.g. `openrouter/anthropic/claude-sonnet-4.6-20260101`).
    pub fn pricing_for(&self, key: &str) -> Option<(f64, f64)> {
        let guard = self.entry.lock().unwrap();
        let models = guard.as_ref()?.1.as_slice();
        models
            .iter()
            .find(|m| m.key == key)
            .or_else(|| models.iter().find(|m| key.starts_with(&m.key)))
            .and_then(|m| Some((m.input_per_1m?, m.output_per_1m?)))
    }

    /// Look up the context window (in tokens) for a model key, using the same
    /// exact-then-prefix match as `pricing_for`. Returns `None` if the model
    /// isn't cached yet or doesn't report a window.
    pub fn context_window_for(&self, key: &str) -> Option<u64> {
        let guard = self.entry.lock().unwrap();
        let models = guard.as_ref()?.1.as_slice();
        models
            .iter()
            .find(|m| m.key == key)
            .or_else(|| models.iter().find(|m| key.starts_with(&m.key)))
            .and_then(|m| m.context_window)
    }
}

fn cli_model_info(provider_id: &str, model: DiscoveredModel) -> ModelInfo {
    ModelInfo {
        key: format!("{}/{}", provider_id, model.id),
        name: model.name,
        provider: Some(provider_id.to_string()),
        local: false,
        context_window: model.context_window,
        // Subscription calls do not consume per-token API credits.
        input_per_1m: Some(0.0),
        output_per_1m: Some(0.0),
    }
}

fn fallback_claude_models(provider_id: &str) -> Vec<ModelInfo> {
    [
        ("opus", "Claude Opus (latest)"),
        ("sonnet", "Claude Sonnet (latest)"),
        ("haiku", "Claude Haiku (latest)"),
    ]
    .into_iter()
    .map(|(id, name)| {
        cli_model_info(
            provider_id,
            DiscoveredModel {
                id: id.to_string(),
                name: name.to_string(),
                context_window: Some(200_000),
                is_default: false,
            },
        )
    })
    .collect()
}

fn codex_default_model(provider_id: &str, resolved: Option<&DiscoveredModel>) -> ModelInfo {
    cli_model_info(
        provider_id,
        DiscoveredModel {
            id: "default".to_string(),
            name: resolved
                .map(|model| format!("Codex (default: {})", model.name))
                .unwrap_or_else(|| "Codex (default)".to_string()),
            context_window: resolved
                .and_then(|model| model.context_window)
                .or(Some(272_000)),
            is_default: true,
        },
    )
}

async fn list_models(State(state): State<AppState>) -> Json<Vec<ModelInfo>> {
    if let Some(cached) = state.model_cache.get() {
        return Json(cached);
    }

    let mut all = Vec::new();
    let mut any_failed = false;
    for cfg in &state.config.providers {
        if cfg.kind == ProviderKind::Cli {
            match cfg.adapter {
                Some(CliAdapter::Claude) => {
                    let provider = CliClaudeProvider::new(cfg);
                    match provider.discover_models().await {
                        Ok(models) => all.extend(
                            models
                                .into_iter()
                                .map(|model| cli_model_info(&cfg.id, model)),
                        ),
                        Err(error) => {
                            any_failed = true;
                            tracing::warn!("{} Claude model discovery failed: {}", cfg.id, error);
                            all.extend(fallback_claude_models(&cfg.id));
                        }
                    }
                }
                Some(CliAdapter::Codex) => {
                    let provider = CliCodexProvider::new(cfg);
                    match provider.discover_models().await {
                        Ok(models) => {
                            // Preserve the rolling account/config-selected route
                            // in addition to exact models, including old favorites
                            // that use `<provider>/default`.
                            all.push(codex_default_model(
                                &cfg.id,
                                models.iter().find(|model| model.is_default),
                            ));
                            all.extend(
                                models
                                    .into_iter()
                                    .map(|model| cli_model_info(&cfg.id, model)),
                            );
                        }
                        Err(error) => {
                            any_failed = true;
                            tracing::warn!("{} Codex model discovery failed: {}", cfg.id, error);
                            all.push(codex_default_model(&cfg.id, None));
                        }
                    }
                }
                None => {
                    any_failed = true;
                    tracing::warn!("CLI provider '{}' has no adapter", cfg.id);
                }
            }
            continue;
        }
        // Whether this provider's models are local (on-device, privacy-
        // preserving). Uses the same rule as private-dir gating so the badge and
        // the trust decision can't disagree (explicit `local` flag + endpoint).
        let local = crate::local::provider_is_local(cfg);
        // Every HTTP provider exposes the OpenAI-compatible `/models` endpoint.
        let base = cfg
            .base_url
            .clone()
            .unwrap_or_else(|| "https://openrouter.ai/api/v1".into());
        match fetch_openai_compatible_models(&base, &cfg.api_key, &cfg.id, local).await {
            Ok(mut models) => all.append(&mut models),
            Err(e) => {
                any_failed = true;
                tracing::warn!("{} model fetch failed: {}", cfg.id, e);
            }
        }
    }

    // Only cache a complete result. If any provider fetch failed (e.g. a
    // transient OpenRouter timeout on cold start), return the partial list for
    // this request but DON'T poison the 1h cache — otherwise one hiccup leaves
    // the SPA with a degraded list for an hour, firing the stale-defaultModel
    // toast and falling back to whatever model happens to be first.
    if !any_failed {
        state.model_cache.set(all.clone());
    }
    Json(all)
}

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelEntry>,
}

#[derive(Deserialize)]
struct OpenAIModelEntry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    pricing: Option<PricingEntry>,
}

#[derive(Deserialize, Default)]
struct PricingEntry {
    /// USD per token (string in OpenRouter's response).
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    completion: Option<String>,
}

fn per_million(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().map(|v| v * 1_000_000.0)
}

/// serde `skip_serializing_if` helper: drop `local: false` from the wire so
/// only on-device models carry the flag.
fn is_false(b: &bool) -> bool {
    !*b
}

async fn fetch_openai_compatible_models(
    base_url: &str,
    api_key: &str,
    provider_id: &str,
    local: bool,
) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let body: OpenAIModelsResponse = response.json().await.map_err(|e| e.to_string())?;

    // All keys are prefixed with our provider id (`openrouter/<vendor>/<model>`
    // or `<provider-id>/<model>`) so the SPA recognizes them under the
    // enabled provider when filtering. Display name has any "Vendor: " prefix
    // stripped so the picker shows "Claude Sonnet 4.6" not
    // "Anthropic: Claude Sonnet 4.6".
    Ok(body
        .data
        .into_iter()
        .map(|m| {
            let key = format!("{}/{}", provider_id, m.id);
            let display = m
                .name
                .as_deref()
                .map(strip_vendor_prefix)
                .map(str::to_string)
                .unwrap_or_else(|| short_id(&m.id));
            let (input_per_1m, output_per_1m) = match &m.pricing {
                Some(p) => (
                    p.prompt.as_deref().and_then(per_million),
                    p.completion.as_deref().and_then(per_million),
                ),
                None => (None, None),
            };
            ModelInfo {
                key,
                name: display,
                provider: Some(provider_id.to_string()),
                local,
                context_window: m.context_length,
                input_per_1m,
                output_per_1m,
            }
        })
        .collect())
}

/// "Anthropic: Claude Sonnet 4.6" → "Claude Sonnet 4.6". OpenRouter's display
/// names follow this `Vendor: Model` convention.
fn strip_vendor_prefix(name: &str) -> &str {
    if let Some(idx) = name.find(": ") {
        // Don't strip if the prefix looks like part of the actual model name
        // (heuristic: stripped portion must be short).
        if idx <= 30 {
            return &name[idx + 2..];
        }
    }
    name
}

/// Fallback display for entries with no `name`: use the last path component
/// of the id, prettified.
fn short_id(id: &str) -> String {
    id.rsplit_once('/').map(|(_, tail)| tail).unwrap_or(id).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_adapter_models_keep_configured_provider_ids() {
        let claude = cli_model_info(
            "work-claude",
            DiscoveredModel {
                id: "sonnet".into(),
                name: "Claude Sonnet 5".into(),
                context_window: Some(200_000),
                is_default: false,
            },
        );
        assert_eq!(claude.key, "work-claude/sonnet");
        assert_eq!(claude.name, "Claude Sonnet 5");
        assert!(!claude.local);

        let default = DiscoveredModel {
            id: "gpt-best".into(),
            name: "GPT Best".into(),
            context_window: Some(272_000),
            is_default: true,
        };
        let codex = codex_default_model("codex-cli", Some(&default));
        assert_eq!(codex.key, "codex-cli/default");
        assert_eq!(codex.name, "Codex (default: GPT Best)");
        assert!(!codex.local);
    }

    #[test]
    fn strips_vendor_prefix() {
        assert_eq!(strip_vendor_prefix("Anthropic: Claude Sonnet 4.6"), "Claude Sonnet 4.6");
        assert_eq!(strip_vendor_prefix("Google: Gemini 3.5 Flash"), "Gemini 3.5 Flash");
        assert_eq!(strip_vendor_prefix("No colon here"), "No colon here");
    }

    #[test]
    fn short_id_extracts_last_segment() {
        assert_eq!(short_id("anthropic/claude-sonnet-4.6"), "claude-sonnet-4.6");
        assert_eq!(short_id("plain-id"), "plain-id");
    }

}
