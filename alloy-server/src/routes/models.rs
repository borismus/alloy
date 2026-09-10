//! `GET /api/models` — aggregate model list across configured providers.
//!
//! Lets the SPA replace its bundled per-provider model lists with the live
//! source of truth. Results are cached for 1h to avoid hammering OpenRouter.
//!
//! Wire shape mirrors `ModelInfo` in [src/types/index.ts](src/types/index.ts):
//! `[{ key: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow?: 1000000 }, ...]`

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    config::{CliAdapter, Config, ProviderConfig, ProviderKind},
    providers::{
        cli_claude::CliClaudeProvider, cli_codex::CliCodexProvider, DiscoveredModel, Provider,
    },
    AppState,
};

const CACHE_TTL: Duration = Duration::from_secs(3600);

/// TTL for a *partial* result (at least one provider failed). Short enough that
/// a provider coming back online is picked up quickly, long enough that the
/// common mobile pattern — foreground the app, which refires discovery — does
/// not re-run multi-second CLI spawns and unreachable-endpoint timeouts on
/// every app switch. Without this a single permanently-offline provider (e.g. a
/// LAN MLX box that is asleep) disabled caching for *every* provider and made
/// each `/api/models` call cost seconds.
const PARTIAL_CACHE_TTL: Duration = Duration::from_secs(60);

/// Where Alloy obtained a model's context-window value. Numeric fields
/// reported by an upstream are authoritative; CLI aliases and assumptions are
/// retained explicitly so later budgeting can apply a larger safety margin.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum ContextWindowSource {
    #[serde(rename = "context_length")]
    ContextLength,
    #[serde(rename = "max_model_len")]
    MaxModelLen,
    #[serde(rename = "max_context_length")]
    MaxContextLength,
    #[serde(rename = "context_window")]
    ContextWindow,
    #[serde(rename = "model_alias")]
    ModelAlias,
    #[serde(rename = "assumed")]
    Assumed,
}

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
    /// False only for providers that cannot accept image attachments at all
    /// (currently `codex exec`, which takes a single text prompt). Omitted from
    /// the wire when true so existing consumers treat absence as "supported".
    #[serde(rename = "supportsImages", skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
    #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(
        rename = "contextWindowSource",
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window_source: Option<ContextWindowSource>,
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

struct CachedProviderModels {
    stored_at: Instant,
    ttl: Duration,
    models: Vec<ModelInfo>,
}

/// Server-owned model catalog, cached independently per provider. Per-provider
/// entries let a headless task discover only its selected model's provider
/// instead of contacting every configured cloud and local service.
#[derive(Default)]
pub struct ModelCache {
    providers: Mutex<HashMap<String, CachedProviderModels>>,
    refresh: tokio::sync::Mutex<()>,
}

fn find_model<'a>(models: &'a [ModelInfo], key: &str) -> Option<&'a ModelInfo> {
    models.iter().find(|model| model.key == key).or_else(|| {
        models
            .iter()
            .filter(|model| key.starts_with(&model.key))
            .max_by_key(|model| model.key.len())
    })
}

impl ModelCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get_provider(&self, provider_id: &str) -> Option<Vec<ModelInfo>> {
        let guard = self.providers.lock().unwrap();
        let cached = guard.get(provider_id)?;
        (cached.stored_at.elapsed() < cached.ttl).then(|| cached.models.clone())
    }

    fn set_provider(&self, provider_id: &str, models: Vec<ModelInfo>, ttl: Duration) {
        self.providers.lock().unwrap().insert(
            provider_id.to_string(),
            CachedProviderModels {
                stored_at: Instant::now(),
                ttl,
                models,
            },
        );
    }

    fn cached_models(&self) -> Vec<ModelInfo> {
        self.providers
            .lock()
            .unwrap()
            .values()
            .flat_map(|entry| entry.models.iter().cloned())
            .collect()
    }

    async fn models_for_provider(&self, config: &ProviderConfig) -> Vec<ModelInfo> {
        if let Some(models) = self.get_provider(&config.id) {
            return models;
        }

        // Avoid duplicate CLI processes/network requests when model-picker and
        // stream startup race. Re-check after acquiring the async lock.
        let _refresh = self.refresh.lock().await;
        if let Some(models) = self.get_provider(&config.id) {
            return models;
        }

        let (models, complete) = discover_provider_models(config).await;
        let ttl = if complete && !models.is_empty() {
            CACHE_TTL
        } else {
            PARTIAL_CACHE_TTL
        };
        // Cache an empty failed discovery briefly as well. Otherwise a sleeping
        // LAN host would add its full connection timeout to every foreground.
        self.set_provider(&config.id, models.clone(), ttl);
        models
    }

    /// Return the complete configured catalog, discovering stale providers as
    /// needed. This powers the HTTP route but is not coupled to it.
    pub async fn models(&self, config: &Config) -> Vec<ModelInfo> {
        let mut all = Vec::new();
        for provider in &config.providers {
            all.extend(self.models_for_provider(provider).await);
        }
        all
    }

    /// Look up a context window while ensuring the selected provider has been
    /// discovered. Scheduled tasks call this path directly, so model limits do
    /// not depend on a browser having requested `/api/models` first.
    pub async fn context_window_for_or_discover(&self, key: &str, config: &Config) -> Option<u64> {
        let provider = config
            .providers
            .iter()
            .filter(|provider| key.starts_with(&format!("{}/", provider.id)))
            .max_by_key(|provider| provider.id.len());
        if let Some(provider) = provider {
            let models = self.models_for_provider(provider).await;
            return find_model(&models, key).and_then(|model| model.context_window);
        }
        self.context_window_for(key)
    }

    /// Look up per-million-token pricing for a `<provider>/<upstream-model>`
    /// key. Falls back to the longest model-prefix match for dated ids.
    pub fn pricing_for(&self, key: &str) -> Option<(f64, f64)> {
        find_model(&self.cached_models(), key)
            .and_then(|model| Some((model.input_per_1m?, model.output_per_1m?)))
    }

    /// Synchronous lookup over already-discovered models.
    pub fn context_window_for(&self, key: &str) -> Option<u64> {
        find_model(&self.cached_models(), key).and_then(|model| model.context_window)
    }
}

fn cli_model_info(
    provider_id: &str,
    model: DiscoveredModel,
    source: ContextWindowSource,
) -> ModelInfo {
    ModelInfo {
        key: format!("{}/{}", provider_id, model.id),
        name: model.name,
        provider: Some(provider_id.to_string()),
        local: false,
        supports_images: None,
        context_window: model.context_window,
        context_window_source: model.context_window.map(|_| source),
        // Subscription calls do not consume per-token API credits.
        input_per_1m: Some(0.0),
        output_per_1m: Some(0.0),
    }
}

fn claude_model_info(provider_id: &str, model: DiscoveredModel) -> ModelInfo {
    let source = if model.id.contains("[1m]")
        || model.id.contains("[2m]")
        || model.name.contains(" · 1M")
        || model.name.contains(" · 2M")
    {
        ContextWindowSource::ModelAlias
    } else {
        ContextWindowSource::Assumed
    };
    cli_model_info(provider_id, model, source)
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
            ContextWindowSource::Assumed,
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
        ContextWindowSource::Assumed,
    )
}

async fn list_models(State(state): State<AppState>) -> Json<Vec<ModelInfo>> {
    let models = state.model_cache.models(&state.config).await;
    if models.is_empty() {
        tracing::warn!("model discovery returned no models");
    }
    Json(models)
}

async fn discover_provider_models(config: &ProviderConfig) -> (Vec<ModelInfo>, bool) {
    if config.kind == ProviderKind::Cli {
        return match config.adapter {
            Some(CliAdapter::Claude) => {
                let provider = CliClaudeProvider::new(config);
                match provider.discover_models().await {
                    Ok(models) => (
                        models
                            .into_iter()
                            .map(|model| claude_model_info(&config.id, model))
                            .collect(),
                        true,
                    ),
                    Err(error) => {
                        tracing::warn!("{} Claude model discovery failed: {}", config.id, error);
                        (fallback_claude_models(&config.id), false)
                    }
                }
            }
            Some(CliAdapter::Codex) => {
                let provider = CliCodexProvider::new(config);
                let (mut models, complete) = match provider.discover_models().await {
                    Ok(discovered) => {
                        let mut models = vec![codex_default_model(
                            &config.id,
                            discovered.iter().find(|model| model.is_default),
                        )];
                        models.extend(discovered.into_iter().map(|model| {
                            cli_model_info(&config.id, model, ContextWindowSource::Assumed)
                        }));
                        (models, true)
                    }
                    Err(error) => {
                        tracing::warn!("{} Codex model discovery failed: {}", config.id, error);
                        (vec![codex_default_model(&config.id, None)], false)
                    }
                };
                if !provider.supports_images("") {
                    for model in &mut models {
                        model.supports_images = Some(false);
                    }
                }
                (models, complete)
            }
            None => {
                tracing::warn!("CLI provider '{}' has no adapter", config.id);
                (Vec::new(), false)
            }
        };
    }

    // Whether this provider's models are local (on-device, privacy-preserving).
    // Uses the same rule as private-dir gating so the badge and trust decision
    // cannot disagree.
    let local = crate::local::provider_is_local(config);
    let base = config
        .base_url
        .clone()
        .unwrap_or_else(|| "https://openrouter.ai/api/v1".into());
    match fetch_openai_compatible_models(&base, &config.api_key, &config.id, local).await {
        Ok(models) => {
            let complete = !models.is_empty();
            (models, complete)
        }
        Err(error) => {
            tracing::warn!("{} model fetch failed: {}", config.id, error);
            (Vec::new(), false)
        }
    }
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
    #[serde(default, deserialize_with = "deserialize_positive_u64")]
    context_length: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_positive_u64")]
    max_model_len: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_positive_u64")]
    max_context_length: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_positive_u64")]
    context_window: Option<u64>,
    #[serde(default)]
    pricing: Option<PricingEntry>,
}

impl OpenAIModelEntry {
    /// Deterministic precedence: OpenRouter's standard field first, followed by
    /// oMLX/vLLM's field and then the less common compatibility aliases.
    fn context_limit(&self) -> Option<(u64, ContextWindowSource)> {
        self.context_length
            .map(|value| (value, ContextWindowSource::ContextLength))
            .or_else(|| {
                self.max_model_len
                    .map(|value| (value, ContextWindowSource::MaxModelLen))
            })
            .or_else(|| {
                self.max_context_length
                    .map(|value| (value, ContextWindowSource::MaxContextLength))
            })
            .or_else(|| {
                self.context_window
                    .map(|value| (value, ContextWindowSource::ContextWindow))
            })
    }
}

fn deserialize_positive_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let parsed = match value {
        serde_json::Value::Number(number) => number.as_u64(),
        serde_json::Value::String(value) => value.trim().parse::<u64>().ok(),
        _ => None,
    };
    Ok(parsed.filter(|value| *value > 0))
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
    Ok(openai_model_infos(body, provider_id, local))
}

fn openai_model_infos(
    body: OpenAIModelsResponse,
    provider_id: &str,
    local: bool,
) -> Vec<ModelInfo> {
    // All keys are prefixed with our provider id (`openrouter/<vendor>/<model>`
    // or `<provider-id>/<model>`) so the SPA recognizes them under the
    // enabled provider when filtering. Display name has any "Vendor: " prefix
    // stripped so the picker shows "Claude Sonnet 4.6" not
    // "Anthropic: Claude Sonnet 4.6".
    body.data
        .into_iter()
        .map(|model| {
            let (context_window, context_window_source) = model
                .context_limit()
                .map(|(limit, source)| (Some(limit), Some(source)))
                .unwrap_or((None, None));
            let key = format!("{}/{}", provider_id, model.id);
            let display = model
                .name
                .as_deref()
                .map(strip_vendor_prefix)
                .map(str::to_string)
                .unwrap_or_else(|| short_id(&model.id));
            let (input_per_1m, output_per_1m) = match &model.pricing {
                Some(pricing) => (
                    pricing.prompt.as_deref().and_then(per_million),
                    pricing.completion.as_deref().and_then(per_million),
                ),
                None => (None, None),
            };
            ModelInfo {
                key,
                name: display,
                provider: Some(provider_id.to_string()),
                local,
                // OpenAI-compatible /models says nothing about image support,
                // so stay optimistic rather than guess per model.
                supports_images: None,
                context_window,
                context_window_source,
                input_per_1m,
                output_per_1m,
            }
        })
        .collect()
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
    id.rsplit_once('/')
        .map(|(_, tail)| tail)
        .unwrap_or(id)
        .to_string()
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
            ContextWindowSource::Assumed,
        );
        assert_eq!(claude.key, "work-claude/sonnet");
        assert_eq!(claude.name, "Claude Sonnet 5");
        assert!(!claude.local);
        assert_eq!(
            claude.context_window_source,
            Some(ContextWindowSource::Assumed)
        );

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

    fn model(key: &str) -> ModelInfo {
        ModelInfo {
            key: key.into(),
            name: key.into(),
            provider: None,
            local: false,
            supports_images: None,
            context_window: None,
            context_window_source: None,
            input_per_1m: None,
            output_per_1m: None,
        }
    }

    #[test]
    fn subscription_cli_adapters_report_image_support() {
        use crate::config::{CliAdapter, ProviderConfig, ProviderKind};
        let cfg = |adapter| ProviderConfig {
            id: "p".into(),
            kind: ProviderKind::Cli,
            adapter: Some(adapter),
            base_url: None,
            api_key: String::new(),
            command: None,
            oauth_token: None,
            local: None,
        };
        // Codex app-server accepts base64 data URL image inputs.
        assert!(CliCodexProvider::new(&cfg(CliAdapter::Codex)).supports_images(""));
        // Claude's stream-json protocol carries base64 image blocks (verified
        // end to end against the real CLI).
        assert!(CliClaudeProvider::new(&cfg(CliAdapter::Claude)).supports_images(""));
    }

    #[test]
    fn supports_images_is_omitted_from_the_wire_when_true() {
        // Absence must keep meaning "supported" for existing consumers.
        let json = serde_json::to_string(&model("a/b")).unwrap();
        assert!(!json.contains("supportsImages"), "got {json}");

        let mut text_only = model("codex-cli/x");
        text_only.supports_images = Some(false);
        let json = serde_json::to_string(&text_only).unwrap();
        assert!(json.contains("\"supportsImages\":false"), "got {json}");
    }

    #[test]
    fn cache_serves_provider_entries_within_their_ttl() {
        let cache = ModelCache::new();
        cache.set_provider("a", vec![model("a/b")], CACHE_TTL);
        assert_eq!(cache.get_provider("a").unwrap().len(), 1);
    }

    #[test]
    fn cache_expires_provider_entries_past_their_ttl() {
        let cache = ModelCache::new();
        // A zero TTL is immediately stale, standing in for elapsed wall time
        // without making the test sleep.
        cache.set_provider("a", vec![model("a/b")], Duration::from_secs(0));
        assert!(cache.get_provider("a").is_none());
    }

    #[test]
    fn partial_results_are_cached_briefly_so_one_dead_provider_is_not_fatal() {
        // Regression: a permanently-unreachable provider used to leave the
        // cache empty forever, so every /api/models call re-ran multi-second
        // CLI spawns and connect timeouts and blocked SPA startup.
        assert!(PARTIAL_CACHE_TTL > Duration::from_secs(0));
        assert!(PARTIAL_CACHE_TTL < CACHE_TTL);

        let cache = ModelCache::new();
        cache.set_provider(
            "reachable",
            vec![model("reachable/model")],
            PARTIAL_CACHE_TTL,
        );
        assert_eq!(cache.get_provider("reachable").unwrap().len(), 1);
    }

    #[test]
    fn pricing_and_context_lookups_read_the_cached_models() {
        let cache = ModelCache::new();
        cache.set_provider(
            "openrouter",
            vec![ModelInfo {
                context_window: Some(200_000),
                context_window_source: Some(ContextWindowSource::ContextLength),
                input_per_1m: Some(3.0),
                output_per_1m: Some(15.0),
                ..model("openrouter/anthropic/claude")
            }],
            CACHE_TTL,
        );
        assert_eq!(
            cache.pricing_for("openrouter/anthropic/claude"),
            Some((3.0, 15.0))
        );
        assert_eq!(
            cache.context_window_for("openrouter/anthropic/claude-20260101"),
            Some(200_000)
        );
    }

    #[test]
    fn openai_compatible_context_aliases_and_precedence_are_preserved() {
        let body: OpenAIModelsResponse = serde_json::from_value(serde_json::json!({
            "data": [
                {
                    "id": "Muse-Glimmer-30B-4bit",
                    "object": "model",
                    "owned_by": "mlx-community",
                    "max_model_len": 131072
                },
                {"id": "qwen", "max_model_len": "262144"},
                {"id": "max-context", "max_context_length": 65536},
                {"id": "context-window", "context_window": 32768},
                {
                    "id": "precedence",
                    "context_length": 200000,
                    "max_model_len": 262144,
                    "max_context_length": 131072,
                    "context_window": 65536
                },
                {
                    "id": "invalid-falls-through",
                    "context_length": 0,
                    "max_model_len": -1,
                    "max_context_length": "not-a-number",
                    "context_window": 8192
                },
                {
                    "id": "unknown",
                    "context_length": 0,
                    "max_model_len": null
                }
            ]
        }))
        .unwrap();

        let models = openai_model_infos(body, "mlx", true);
        let limit = |id: &str| {
            let model = models
                .iter()
                .find(|model| model.key == format!("mlx/{id}"))
                .unwrap();
            (model.context_window, model.context_window_source)
        };
        assert_eq!(
            limit("Muse-Glimmer-30B-4bit"),
            (Some(131_072), Some(ContextWindowSource::MaxModelLen))
        );
        assert_eq!(
            limit("qwen"),
            (Some(262_144), Some(ContextWindowSource::MaxModelLen))
        );
        assert_eq!(
            limit("max-context"),
            (Some(65_536), Some(ContextWindowSource::MaxContextLength))
        );
        assert_eq!(
            limit("context-window"),
            (Some(32_768), Some(ContextWindowSource::ContextWindow))
        );
        assert_eq!(
            limit("precedence"),
            (Some(200_000), Some(ContextWindowSource::ContextLength))
        );
        assert_eq!(
            limit("invalid-falls-through"),
            (Some(8_192), Some(ContextWindowSource::ContextWindow))
        );
        assert_eq!(limit("unknown"), (None, None));
    }

    #[tokio::test]
    async fn headless_lookup_discovers_only_the_selected_provider() {
        let app = axum::Router::new().route(
            "/models",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "data": [{"id": "qwen", "max_model_len": 262144}]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = Config {
            providers: vec![
                ProviderConfig {
                    id: "selected".into(),
                    kind: ProviderKind::OpenaiCompatible,
                    adapter: None,
                    base_url: Some(format!("http://{address}")),
                    api_key: "test".into(),
                    command: None,
                    oauth_token: None,
                    local: Some(true),
                },
                ProviderConfig {
                    id: "unrelated".into(),
                    kind: ProviderKind::OpenaiCompatible,
                    adapter: None,
                    base_url: Some("http://127.0.0.1:9".into()),
                    api_key: "test".into(),
                    command: None,
                    oauth_token: None,
                    local: Some(true),
                },
            ],
            ..Config::default()
        };

        let cache = ModelCache::new();
        assert_eq!(
            cache
                .context_window_for_or_discover("selected/qwen", &config)
                .await,
            Some(262_144)
        );
        assert!(cache.get_provider("unrelated").is_none());
        assert_eq!(
            cache.cached_models()[0].context_window_source,
            Some(ContextWindowSource::MaxModelLen)
        );
        server.abort();
    }

    #[test]
    fn strips_vendor_prefix() {
        assert_eq!(
            strip_vendor_prefix("Anthropic: Claude Sonnet 4.6"),
            "Claude Sonnet 4.6"
        );
        assert_eq!(
            strip_vendor_prefix("Google: Gemini 3.5 Flash"),
            "Gemini 3.5 Flash"
        );
        assert_eq!(strip_vendor_prefix("No colon here"), "No colon here");
    }

    #[test]
    fn short_id_extracts_last_segment() {
        assert_eq!(short_id("anthropic/claude-sonnet-4.6"), "claude-sonnet-4.6");
        assert_eq!(short_id("plain-id"), "plain-id");
    }
}
