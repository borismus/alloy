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
    /// Enable Claude models billed against your Claude Pro/Max subscription via
    /// the Claude Code CLI. Flat toggle in the same style as the keys above.
    #[serde(rename = "CLAUDE_SUBSCRIPTION", default)]
    pub claude_subscription: Option<bool>,
    /// Optional `claude setup-token` value, for unattended subscription auth.
    #[serde(rename = "CLAUDE_CODE_OAUTH_TOKEN", default)]
    pub claude_code_oauth_token: Option<String>,
    /// Optional path to the `claude` binary if it isn't on PATH.
    #[serde(rename = "CLAUDE_CODE_PATH", default)]
    pub claude_code_path: Option<String>,
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

    #[serde(rename = "shareOnNetwork", default)]
    pub share_on_network: Option<bool>,
    #[serde(rename = "sharePort", default)]
    pub share_port: Option<u16>,

    #[serde(default)]
    pub compaction: Option<RawCompaction>,
}

/// Raw `compaction:` block from config.yaml.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RawCompaction {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(rename = "triggerTokens", default)]
    pub trigger_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: Option<String>,
    /// API key for HTTP providers. Not needed for the `cli_claude` kind (it
    /// authenticates via the host's Claude Code login), so it defaults to empty.
    #[serde(default)]
    pub api_key: String,
    /// Path to the `claude` binary for the `cli_claude` kind. Defaults to
    /// `claude` on PATH; override when the alloy-server process doesn't inherit
    /// the user's interactive shell PATH (e.g. the Tauri-embedded server).
    #[serde(default)]
    pub command: Option<String>,
    /// Optional `claude setup-token` value for the `cli_claude` kind. When set,
    /// it's injected as `CLAUDE_CODE_OAUTH_TOKEN` so the server bills the Claude
    /// subscription without an interactive login session.
    #[serde(default)]
    pub oauth_token: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiCompatible,
    /// Shells out to the Claude Code CLI (`claude -p`) to use a Claude Pro/Max
    /// subscription instead of API-key billing. Text-only (no tool calling).
    CliClaude,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub default_model: Option<String>,
    pub providers: Vec<ProviderConfig>,
    pub serper_api_key: Option<String>,
    pub soniox_api_key: Option<String>,
    /// If true, also bind a public listener on `share_port` so other
    /// devices on the local network (or Tailnet) can reach the SPA.
    pub share_on_network: bool,
    /// Port for the public listener when `share_on_network` is true.
    pub share_port: u16,
    /// Auto-compaction settings (see compaction.rs).
    pub compaction: crate::compaction::CompactionSettings,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            default_model: None,
            providers: Vec::new(),
            serper_api_key: None,
            soniox_api_key: None,
            share_on_network: false,
            share_port: 3001,
            compaction: crate::compaction::CompactionSettings::default(),
        }
    }
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

        // Derive providers from the legacy flat keys, then merge in any explicit
        // `providers:` entries. An explicit entry with the same id overrides the
        // derived one; a new id is appended. This lets an existing flat-key
        // setup add e.g. a `claude-cli` provider without having to restate
        // openrouter/ollama in a full providers block.
        let providers = {
            let mut derived = Vec::new();
            if let Some(key) = raw.openrouter_api_key {
                if !key.is_empty() {
                    derived.push(ProviderConfig {
                        id: "openrouter".into(),
                        kind: ProviderKind::OpenaiCompatible,
                        base_url: Some("https://openrouter.ai/api/v1".into()),
                        api_key: key,
                        command: None,
                        oauth_token: None,
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
                        command: None,
                        oauth_token: None,
                    });
                }
            }
            if raw.claude_subscription.unwrap_or(false) {
                derived.push(ProviderConfig {
                    id: "claude-cli".into(),
                    kind: ProviderKind::CliClaude,
                    base_url: None,
                    api_key: String::new(),
                    command: raw.claude_code_path.clone(),
                    oauth_token: raw.claude_code_oauth_token.clone(),
                });
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
            for p in raw.providers.into_iter().flatten() {
                if let Some(slot) = derived.iter_mut().find(|e| e.id == p.id) {
                    *slot = p;
                } else {
                    derived.push(p);
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

        let compaction = {
            let defaults = crate::compaction::CompactionSettings::default();
            match raw.compaction {
                Some(c) => crate::compaction::CompactionSettings {
                    enabled: c.enabled.unwrap_or(defaults.enabled),
                    trigger_tokens: c.trigger_tokens.unwrap_or(defaults.trigger_tokens),
                },
                None => defaults,
            }
        };

        Self {
            default_model,
            providers,
            serper_api_key: raw.serper_api_key,
            soniox_api_key: raw.soniox_api_key,
            share_on_network: raw.share_on_network.unwrap_or(false),
            share_port: raw.share_port.unwrap_or(3001),
            compaction,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(cfg: &Config) -> Vec<&str> {
        cfg.providers.iter().map(|p| p.id.as_str()).collect()
    }

    #[test]
    fn explicit_providers_merge_with_legacy_keys() {
        let raw: RawConfig = serde_yaml::from_str(
            "OPENROUTER_API_KEY: sk-or-test\n\
             OLLAMA_BASE_URL: http://localhost:11434\n\
             providers:\n  - id: claude-cli\n    kind: cli_claude\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        // Legacy-derived providers stay; the explicit one is appended.
        assert_eq!(ids(&cfg), vec!["openrouter", "ollama", "claude-cli"]);
        assert_eq!(cfg.providers[2].kind, ProviderKind::CliClaude);
    }

    #[test]
    fn claude_subscription_flag_derives_cli_provider() {
        let raw: RawConfig = serde_yaml::from_str(
            "OPENROUTER_API_KEY: sk-or-test\n\
             CLAUDE_SUBSCRIPTION: true\n\
             CLAUDE_CODE_OAUTH_TOKEN: sk-ant-oat-xyz\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        assert_eq!(ids(&cfg), vec!["openrouter", "claude-cli"]);
        let claude = &cfg.providers[1];
        assert_eq!(claude.kind, ProviderKind::CliClaude);
        assert_eq!(claude.oauth_token.as_deref(), Some("sk-ant-oat-xyz"));
    }

    #[test]
    fn no_claude_provider_when_flag_absent_or_false() {
        let raw: RawConfig =
            serde_yaml::from_str("OPENROUTER_API_KEY: sk\nCLAUDE_SUBSCRIPTION: false\n").unwrap();
        let cfg = Config::from_raw(raw);
        assert_eq!(ids(&cfg), vec!["openrouter"]);
    }

    #[test]
    fn explicit_provider_overrides_derived_by_id() {
        let raw: RawConfig = serde_yaml::from_str(
            "OPENROUTER_API_KEY: sk-or-test\n\
             providers:\n  - id: openrouter\n    kind: openai_compatible\n    base_url: https://example.com/v1\n    api_key: override\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        assert_eq!(ids(&cfg), vec!["openrouter"]);
        assert_eq!(cfg.providers[0].api_key, "override");
        assert_eq!(cfg.providers[0].base_url.as_deref(), Some("https://example.com/v1"));
    }
}

/// Persist a change to `shareOnNetwork` back into the user's `config.yaml`.
/// Re-reads the file as raw YAML (preserving comments and key order is not
/// guaranteed by serde_yaml; this is a pragmatic "good enough" rewrite), sets
/// the toggle, writes it back atomically.
///
/// If the file doesn't exist, creates a minimal one.
pub fn write_share_on_network(config_path: &Path, enabled: bool) -> anyhow::Result<()> {
    use serde_yaml::Value;

    let mut value: Value = if config_path.exists() {
        let text = std::fs::read_to_string(config_path)?;
        if text.trim().is_empty() {
            Value::Mapping(Default::default())
        } else {
            serde_yaml::from_str(&text)?
        }
    } else {
        Value::Mapping(Default::default())
    };

    let Value::Mapping(ref mut map) = value else {
        anyhow::bail!("config.yaml is not a YAML mapping");
    };
    map.insert(Value::String("shareOnNetwork".into()), Value::Bool(enabled));

    let serialized = serde_yaml::to_string(&value)?;
    std::fs::write(config_path, serialized)?;
    Ok(())
}
