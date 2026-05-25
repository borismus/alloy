//! Load and interpret `config.yaml` from the vault.
//!
//! V_next config schema supports a `providers:` block; for backward compat
//! with today's per-key config (`OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`),
//! we auto-derive a `providers:` list when none is present.

use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RawConfig {
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(rename = "defaultModel", default)]
    pub default_model_camel: Option<String>,

    #[serde(default)]
    pub providers: Option<Vec<ProviderConfig>>,

    // Legacy flat keys we still honor for migration.
    #[serde(rename = "OPENROUTER_API_KEY", default)]
    pub openrouter_api_key: Option<String>,
    #[serde(rename = "OLLAMA_BASE_URL", default)]
    pub ollama_base_url: Option<String>,
    #[serde(rename = "ANTHROPIC_API_KEY", default)]
    pub anthropic_api_key: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", default)]
    pub openai_api_key: Option<String>,
    #[serde(rename = "GEMINI_API_KEY", default)]
    pub gemini_api_key: Option<String>,
    #[serde(rename = "XAI_API_KEY", default)]
    pub xai_api_key: Option<String>,
    #[serde(rename = "SERPER_API_KEY", default)]
    pub serper_api_key: Option<String>,
    #[serde(rename = "SONIOX_API_KEY", default)]
    pub soniox_api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: Option<String>,
    pub api_key: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiCompatible,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub default_model: Option<String>,
    pub providers: Vec<ProviderConfig>,
    pub serper_api_key: Option<String>,
    pub soniox_api_key: Option<String>,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw_text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Failed to read {}: {}", path.display(), e))?;
        let raw: RawConfig = serde_yaml::from_str(&raw_text)
            .map_err(|e| anyhow::anyhow!("Failed to parse {}: {}", path.display(), e))?;
        Ok(Self::from_raw(raw))
    }

    fn from_raw(raw: RawConfig) -> Self {
        let default_model = raw.default_model_camel.or(raw.default_model);

        // Honor an explicit providers: block if present; otherwise derive one
        // from the legacy flat keys so existing setups keep working.
        let providers = if let Some(p) = raw.providers {
            p
        } else {
            let mut derived = Vec::new();
            if let Some(key) = raw.openrouter_api_key {
                if !key.is_empty() {
                    derived.push(ProviderConfig {
                        id: "openrouter".into(),
                        kind: ProviderKind::OpenaiCompatible,
                        base_url: Some("https://openrouter.ai/api/v1".into()),
                        api_key: key,
                    });
                }
            }
            if let Some(base) = raw.ollama_base_url {
                if !base.is_empty() {
                    // Ollama exposes /v1/chat/completions (OpenAI-compatible).
                    let normalized = if base.ends_with("/v1") {
                        base
                    } else {
                        format!("{}/v1", base.trim_end_matches('/'))
                    };
                    derived.push(ProviderConfig {
                        id: "ollama".into(),
                        kind: ProviderKind::OpenaiCompatible,
                        base_url: Some(normalized),
                        api_key: "ollama".into(),
                    });
                }
            }
            // Warn if old per-provider keys are set — they're ignored in V_next.
            for (name, set) in [
                ("ANTHROPIC_API_KEY", raw.anthropic_api_key.is_some()),
                ("OPENAI_API_KEY", raw.openai_api_key.is_some()),
                ("GEMINI_API_KEY", raw.gemini_api_key.is_some()),
                ("XAI_API_KEY", raw.xai_api_key.is_some()),
            ] {
                if set {
                    tracing::warn!(
                        "{} is set but ignored in V_next — use OPENROUTER_API_KEY (or a `providers:` block) instead",
                        name
                    );
                }
            }
            derived
        };

        if providers.is_empty() {
            tracing::warn!(
                "No providers configured. Set OPENROUTER_API_KEY or add a `providers:` block to config.yaml."
            );
        } else {
            for p in &providers {
                tracing::info!("provider configured: {} ({:?})", p.id, p.kind);
            }
        }

        Self {
            default_model,
            providers,
            serper_api_key: raw.serper_api_key,
            soniox_api_key: raw.soniox_api_key,
        }
    }
}
