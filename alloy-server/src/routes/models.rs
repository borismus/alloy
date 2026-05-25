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

use axum::{Json, Router, extract::State, routing::get};
use serde::{Deserialize, Serialize};

use crate::AppState;

const CACHE_TTL: Duration = Duration::from_secs(3600);

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub key: String,
    pub name: String,
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
}

async fn list_models(State(state): State<AppState>) -> Json<Vec<ModelInfo>> {
    if let Some(cached) = state.model_cache.get() {
        return Json(cached);
    }

    let mut all = Vec::new();
    for cfg in &state.config.providers {
        match cfg.id.as_str() {
            "ollama" => {
                if let Some(base) = &cfg.base_url {
                    match fetch_ollama_models(base).await {
                        Ok(mut models) => all.append(&mut models),
                        Err(e) => tracing::warn!("ollama model fetch failed: {}", e),
                    }
                }
            }
            _ => {
                // Anything else is treated as an OpenAI-compatible upstream
                // (covers OpenRouter, custom routes, etc).
                let base = cfg
                    .base_url
                    .clone()
                    .unwrap_or_else(|| "https://openrouter.ai/api/v1".into());
                match fetch_openai_compatible_models(&base, &cfg.api_key, &cfg.id).await {
                    Ok(mut models) => all.append(&mut models),
                    Err(e) => tracing::warn!("{} model fetch failed: {}", cfg.id, e),
                }
            }
        }
    }

    state.model_cache.set(all.clone());
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

async fn fetch_openai_compatible_models(
    base_url: &str,
    api_key: &str,
    provider_id: &str,
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
                context_window: m.context_length,
                input_per_1m,
                output_per_1m,
            }
        })
        .collect())
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaTagEntry>,
}

#[derive(Deserialize)]
struct OllamaTagEntry {
    name: String,
}

async fn fetch_ollama_models(base_url: &str) -> Result<Vec<ModelInfo>, String> {
    // Ollama's tag endpoint lives at the API root (not under /v1).
    let root = base_url.trim_end_matches("/v1").trim_end_matches('/');
    let url = format!("{}/api/tags", root);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let body: OllamaTagsResponse = response.json().await.map_err(|e| e.to_string())?;
    Ok(body
        .models
        .into_iter()
        .map(|m| ModelInfo {
            key: format!("ollama/{}", m.name),
            name: m.name,
            context_window: None,
            input_per_1m: Some(0.0),
            output_per_1m: Some(0.0),
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
