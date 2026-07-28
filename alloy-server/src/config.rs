//! Load and interpret `config.yaml` (the v2 schema) from the vault.
//!
//! v2 keeps the v1 camelCase, providers-only shape but unifies subscription CLI
//! providers as `kind: cli` plus `adapter: claude | codex`. There is intentionally
//! no automatic migration: old flat-key configs, v1 configs, and old CLI kinds
//! fail loudly with actionable guidance.

use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawConfig {
    /// Schema version. v2 requires `version: 2`.
    #[serde(default)]
    pub version: Option<u32>,

    #[serde(default)]
    pub default_model: Option<String>,

    // SPA-facing UI fields. The Rust model layer doesn't use these, but the
    // single config parser must surface them to the SPA via `GET /api/config`.
    #[serde(default)]
    pub favorite_models: Option<Vec<String>>,
    #[serde(default)]
    pub external_editor: Option<String>,

    #[serde(default)]
    pub providers: Option<Vec<ProviderConfig>>,

    #[serde(default)]
    pub serper_api_key: Option<String>,
    #[serde(default)]
    pub soniox_api_key: Option<String>,

    #[serde(default)]
    pub share_on_network: Option<bool>,
    #[serde(default)]
    pub share_port: Option<u16>,

    /// External directories that local (on-device / trusted) models may read
    /// but cloud models may not — see [`PrivateDir`] and `tools::private`.
    #[serde(default)]
    pub private_read_only_dirs: Option<Vec<PrivateDir>>,

    /// Grouped external-service credentials (email, and later search/dictation).
    #[serde(default)]
    pub services: Option<RawServices>,

    #[serde(default)]
    pub compaction: Option<RawCompaction>,
}

/// `services:` block. Concern-grouped credentials for outbound integrations.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawServices {
    #[serde(default)]
    pub email: Option<RawEmail>,
}

/// `services.email:` — transactional email for task notifications. Only Resend
/// is supported today.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawEmail {
    /// Provider id. Must be `resend` (the only supported provider).
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Verified sender, e.g. `Alloy <alloy@example.com>`.
    #[serde(default)]
    pub from: Option<String>,
    /// One or more recipients (a single address or a list).
    #[serde(default)]
    pub to: Option<StringOrVec>,
}

/// Accept a scalar or a sequence for fields like `to:` that are naturally one
/// value but occasionally several.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StringOrVec {
    One(String),
    Many(Vec<String>),
}

impl StringOrVec {
    fn into_vec(self) -> Vec<String> {
        match self {
            StringOrVec::One(s) => vec![s],
            StringOrVec::Many(v) => v,
        }
    }
}

/// A private read-only directory mounted for local models under
/// `private/<alias>/`. `path` is an absolute path outside the vault (e.g. a
/// separate Obsidian vault); local models read it via the mount, cloud models
/// can't reach it or learn it exists.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateDir {
    pub alias: String,
    pub path: std::path::PathBuf,
    /// Subpaths (relative to `path`) to skip when a local model lists/searches
    /// this mount — e.g. the nested Alloy vault, so chat history isn't scanned.
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
    /// Human description of what this mount holds, surfaced to local models so
    /// they know it's the user's real notes (vs. the app's own `notes/`).
    #[serde(default)]
    pub description: Option<String>,
}

/// Raw `compaction:` block from config.yaml.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawCompaction {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub trigger_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub kind: ProviderKind,
    /// Required for `kind: cli`; forbidden for `openai_compatible`.
    #[serde(default)]
    pub adapter: Option<CliAdapter>,
    #[serde(default)]
    pub base_url: Option<String>,
    /// API key for HTTP providers. CLI adapters authenticate through their host
    /// CLI login, so this defaults to empty.
    #[serde(default)]
    pub api_key: String,
    /// Optional executable override for a CLI adapter. Each adapter otherwise
    /// resolves its conventional binary (`claude` or `codex`) from known install
    /// locations and PATH.
    #[serde(default)]
    pub command: Option<String>,
    /// Optional `claude setup-token` value. Valid only with `adapter: claude`;
    /// injected as `CLAUDE_CODE_OAUTH_TOKEN` for subscription billing.
    #[serde(default)]
    pub oauth_token: Option<String>,
    /// Explicit privacy/offline trust boundary. Only `local: true` marks an
    /// on-device / private-LAN endpoint as local (padlock badge, private-dir
    /// access, offline tolerance); false or omitted is cloud. Valid only for
    /// `openai_compatible`; CLI adapters always send prompts to the cloud.
    #[serde(default)]
    pub local: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiCompatible,
    Cli,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliAdapter {
    Claude,
    Codex,
}

/// Resolved email-notification settings. `Some` only when `services.email` is
/// fully specified for a supported provider (Resend).
#[derive(Debug, Clone)]
pub struct EmailConfig {
    pub api_key: String,
    pub from: String,
    pub to: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub default_model: Option<String>,
    pub providers: Vec<ProviderConfig>,
    pub serper_api_key: Option<String>,
    pub soniox_api_key: Option<String>,
    /// Email notifications for scheduled tasks (Resend). `None` when unconfigured.
    pub email: Option<EmailConfig>,
    /// If true, also bind a public listener on `share_port` so other
    /// devices on the local network (or Tailnet) can reach the SPA.
    pub share_on_network: bool,
    /// Port for the public listener when `share_on_network` is true.
    pub share_port: u16,
    /// External read-only dirs local models may read (mounted at `private/<alias>/`).
    /// Validated against the vault root at bootstrap (see `validate_private_dirs`).
    pub private_read_only_dirs: Vec<PrivateDir>,
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
            email: None,
            share_on_network: false,
            share_port: 3001,
            private_read_only_dirs: Vec::new(),
            compaction: crate::compaction::CompactionSettings::default(),
        }
    }
}

/// Legacy (pre-0.4) top-level keys. Their presence means the config predates the
/// v1 schema; we refuse to load rather than silently drop the user's providers.
const LEGACY_KEYS: &[&str] = &[
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "CLAUDE_SUBSCRIPTION",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PATH",
    "SERPER_API_KEY",
    "SONIOX_API_KEY",
    "default_model",
];

/// Fail loudly if `text` is a pre-0.4 config. There is no automatic migration;
/// the message points at the current v2 shape so the user can update by hand.
fn detect_legacy_format(text: &str) -> anyhow::Result<()> {
    let value: serde_yaml::Value = match serde_yaml::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()), // parse errors surface later with a better message
    };
    if let serde_yaml::Value::Mapping(map) = value {
        let found: Vec<&str> = LEGACY_KEYS
            .iter()
            .copied()
            .filter(|k| map.contains_key(serde_yaml::Value::String((*k).to_string())))
            .collect();
        if !found.is_empty() {
            anyhow::bail!(
                "config.yaml uses the old pre-0.4 format (found: {}). Current Alloy uses a \
                 single camelCase schema with all models under a `providers:` list, e.g.:\n\
                 \n\
                 version: 2\n\
                 defaultModel: openrouter/anthropic/claude-opus-4-6\n\
                 providers:\n\
                 \x20\x20- id: openrouter\n\
                 \x20\x20\x20\x20kind: openai_compatible\n\
                 \x20\x20\x20\x20baseUrl: https://openrouter.ai/api/v1\n\
                 \x20\x20\x20\x20apiKey: sk-or-...\n\
                 \x20\x20- id: mlx\n\
                 \x20\x20\x20\x20kind: openai_compatible\n\
                 \x20\x20\x20\x20baseUrl: http://your-mac.local:8000/v1\n\
                 \x20\x20\x20\x20local: true\n\
                 \n\
                 Update config.yaml to this shape and restart.",
                found.join(", ")
            );
        }
    }
    Ok(())
}

/// Parse and validate the single canonical config schema. Shared by startup and
/// `/api/config` so the backend never has two definitions of a valid config.
pub(crate) fn parse_raw_config(text: &str) -> anyhow::Result<RawConfig> {
    detect_legacy_format(text)?;

    // Inspect the untyped YAML first so removed v1 CLI kinds get a useful error
    // instead of Serde's generic "unknown variant" diagnostic.
    let value: serde_yaml::Value = serde_yaml::from_str(text)?;
    let map = value
        .as_mapping()
        .ok_or_else(|| anyhow::anyhow!("config.yaml must be a YAML mapping"))?;
    if let Some(providers) = map
        .get(serde_yaml::Value::String("providers".into()))
        .and_then(serde_yaml::Value::as_sequence)
    {
        for provider in providers {
            let Some(provider) = provider.as_mapping() else { continue };
            let kind = provider
                .get(serde_yaml::Value::String("kind".into()))
                .and_then(serde_yaml::Value::as_str);
            let replacement = match kind {
                Some("cli_claude") => Some("claude"),
                Some("cli_codex") => Some("codex"),
                _ => None,
            };
            if let Some(adapter) = replacement {
                anyhow::bail!(
                    "config.yaml uses removed config v1 provider kind '{}'. Alloy config v2 uses:\n\
                     version: 2\n\
                     providers:\n\
                     \x20\x20- id: {}-cli\n\
                     \x20\x20\x20\x20kind: cli\n\
                     \x20\x20\x20\x20adapter: {}\n\
                     Update config.yaml and restart.",
                    kind.unwrap(),
                    adapter,
                    adapter,
                );
            }
        }
    }

    let version = map
        .get(serde_yaml::Value::String("version".into()))
        .and_then(serde_yaml::Value::as_u64);
    if version != Some(2) {
        match version {
            Some(v) => anyhow::bail!(
                "config.yaml has version: {v}; Alloy requires config version: 2. Update the version and replace CLI provider kinds with `kind: cli` plus `adapter: claude | codex`, then restart."
            ),
            None => anyhow::bail!(
                "config.yaml is missing `version: 2`. Add it at the top and use `kind: cli` plus `adapter: claude | codex` for subscription CLI providers, then restart."
            ),
        }
    }

    let raw: RawConfig = serde_yaml::from_value(value)?;
    for provider in raw.providers.as_deref().unwrap_or_default() {
        match provider.kind {
            ProviderKind::OpenaiCompatible if provider.adapter.is_some() => anyhow::bail!(
                "provider '{}': `adapter` is valid only with `kind: cli`",
                provider.id
            ),
            ProviderKind::Cli if provider.adapter.is_none() => anyhow::bail!(
                "provider '{}': `kind: cli` requires `adapter: claude` or `adapter: codex`",
                provider.id
            ),
            ProviderKind::Cli if provider.local.is_some() => anyhow::bail!(
                "provider '{}': `local` is valid only with `kind: openai_compatible`; CLI adapters are always cloud",
                provider.id
            ),
            ProviderKind::Cli
                if provider.adapter == Some(CliAdapter::Codex)
                    && provider.oauth_token.as_deref().is_some_and(|s| !s.trim().is_empty()) =>
            {
                anyhow::bail!(
                    "provider '{}': `oauthToken` is supported only by `adapter: claude`",
                    provider.id
                )
            }
            _ => {}
        }
    }
    Ok(raw)
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw_text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Failed to read {}: {}", path.display(), e))?;
        let raw = parse_raw_config(&raw_text)
            .map_err(|e| anyhow::anyhow!("Failed to parse {}: {}", path.display(), e))?;
        Ok(Self::from_raw(raw))
    }

    fn from_raw(raw: RawConfig) -> Self {
        let providers = raw.providers.unwrap_or_default();

        if providers.is_empty() {
            tracing::warn!(
                "No providers configured. Add a `providers:` block to config.yaml."
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

        // Lexically normalize each private-dir path (collapse `.`/`..`). Filesystem
        // validation (absolute + outside the vault) is deferred to
        // `validate_private_dirs`, which runs at bootstrap where the vault root is
        // known — this keeps `from_raw` I/O-free for tests.
        let private_read_only_dirs = raw
            .private_read_only_dirs
            .into_iter()
            .flatten()
            .map(|d| PrivateDir {
                alias: d.alias,
                path: crate::vault::normalize_path(&d.path),
                exclude_dirs: d.exclude_dirs,
                description: d.description,
            })
            .collect();

        let email = resolve_email(raw.services.and_then(|s| s.email));

        Self {
            default_model: raw.default_model,
            providers,
            serper_api_key: raw.serper_api_key,
            soniox_api_key: raw.soniox_api_key,
            email,
            share_on_network: raw.share_on_network.unwrap_or(false),
            share_port: raw.share_port.unwrap_or(3001),
            private_read_only_dirs,
            compaction,
        }
    }

    /// Enforce the external-only invariant on `private_read_only_dirs` once the
    /// vault root is known: drop (with a warning) any entry whose path isn't
    /// absolute, doesn't exist, or lives inside the vault. Runs at bootstrap in
    /// both the standalone (`main.rs`) and Tauri-embedded (`embed.rs`) paths.
    pub fn validate_private_dirs(&mut self, vault_root: &Path) {
        self.private_read_only_dirs.retain(|d| {
            if !d.path.is_absolute() {
                tracing::warn!(
                    "privateReadOnlyDirs: dropping '{}' — path must be absolute: {}",
                    d.alias,
                    d.path.display()
                );
                return false;
            }
            match d.path.canonicalize() {
                Ok(canon) => {
                    if canon.starts_with(vault_root) {
                        tracing::warn!(
                            "privateReadOnlyDirs: dropping '{}' — path is inside the vault (must be external): {}",
                            d.alias,
                            d.path.display()
                        );
                        return false;
                    }
                    tracing::info!(
                        "private read-only dir: private/{} -> {}",
                        d.alias,
                        canon.display()
                    );
                    true
                }
                Err(e) => {
                    tracing::warn!(
                        "privateReadOnlyDirs: dropping '{}' — path does not exist or is unreadable ({}): {}",
                        d.alias,
                        e,
                        d.path.display()
                    );
                    false
                }
            }
        });
    }
}

/// Resolve `services.email` into a usable `EmailConfig`. Returns `None` (and
/// warns on partial config) unless the provider is Resend and api_key/from/to
/// are all present, so a half-filled block silently degrades to "no email".
fn resolve_email(raw: Option<RawEmail>) -> Option<EmailConfig> {
    let raw = raw?;
    let provider = raw.provider.as_deref().unwrap_or("resend").to_lowercase();
    if provider != "resend" {
        tracing::warn!(
            "services.email: unsupported provider '{}' (only 'resend' is supported) — email disabled",
            provider
        );
        return None;
    }
    let api_key = raw.api_key.filter(|s| !s.trim().is_empty());
    let from = raw.from.filter(|s| !s.trim().is_empty());
    let to: Vec<String> = raw
        .to
        .map(StringOrVec::into_vec)
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    match (api_key, from) {
        (Some(api_key), Some(from)) if !to.is_empty() => {
            Some(EmailConfig { api_key, from, to })
        }
        _ => {
            tracing::warn!(
                "services.email: incomplete (need apiKey, from, and at least one to) — email disabled"
            );
            None
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
    fn parses_v2_providers_with_camelcase_keys() {
        let raw = parse_raw_config(
            "version: 2\n\
             defaultModel: openrouter/anthropic/claude-opus-4-6\n\
             providers:\n\
             \x20\x20- id: openrouter\n\
             \x20\x20\x20\x20kind: openai_compatible\n\
             \x20\x20\x20\x20baseUrl: https://openrouter.ai/api/v1\n\
             \x20\x20\x20\x20apiKey: sk-or-test\n\
             \x20\x20- id: mlx\n\
             \x20\x20\x20\x20kind: openai_compatible\n\
             \x20\x20\x20\x20baseUrl: http://smus-m4.local:8000/v1\n\
             \x20\x20\x20\x20local: true\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        assert_eq!(ids(&cfg), vec!["openrouter", "mlx"]);
        assert_eq!(cfg.default_model.as_deref(), Some("openrouter/anthropic/claude-opus-4-6"));
        assert_eq!(cfg.providers[0].base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
        assert_eq!(cfg.providers[0].api_key, "sk-or-test");
        assert_eq!(cfg.providers[0].local, None);
        assert_eq!(cfg.providers[1].local, Some(true));
    }

    #[test]
    fn cli_adapters_parse() {
        let raw = parse_raw_config(
            "version: 2\nproviders:\n  - id: claude-cli\n    kind: cli\n    adapter: claude\n    oauthToken: sk-ant-oat-xyz\n  - id: codex-cli\n    kind: cli\n    adapter: codex\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        assert_eq!(ids(&cfg), vec!["claude-cli", "codex-cli"]);
        assert_eq!(cfg.providers[0].kind, ProviderKind::Cli);
        assert_eq!(cfg.providers[0].adapter, Some(CliAdapter::Claude));
        assert_eq!(cfg.providers[0].oauth_token.as_deref(), Some("sk-ant-oat-xyz"));
        assert_eq!(cfg.providers[1].adapter, Some(CliAdapter::Codex));
    }

    #[test]
    fn empty_v2_config_has_no_providers() {
        let raw = parse_raw_config("version: 2\n").unwrap();
        let cfg = Config::from_raw(raw);
        assert!(cfg.providers.is_empty());
    }

    #[test]
    fn rejects_old_config_formats_and_invalid_cli_shapes() {
        assert!(detect_legacy_format("OPENROUTER_API_KEY: sk-or-test\n").is_err());
        assert!(detect_legacy_format("CLAUDE_SUBSCRIPTION: true\n").is_err());
        assert!(detect_legacy_format("default_model: openrouter/x\n").is_err());
        assert!(detect_legacy_format("SONIOX_API_KEY: s\n").is_err());

        let old_claude = parse_raw_config(
            "version: 1\nproviders:\n  - id: claude-cli\n    kind: cli_claude\n",
        )
        .unwrap_err()
        .to_string();
        assert!(old_claude.contains("kind: cli"));
        assert!(old_claude.contains("adapter: claude"));
        assert!(parse_raw_config("version: 1\nproviders: []\n").is_err());
        assert!(parse_raw_config("providers: []\n").is_err());
        assert!(parse_raw_config(
            "version: 2\nproviders:\n  - id: broken\n    kind: cli\n"
        )
        .is_err());
        assert!(parse_raw_config(
            "version: 2\nproviders:\n  - id: broken\n    kind: openai_compatible\n    adapter: claude\n"
        )
        .is_err());
        assert!(parse_raw_config(
            "version: 2\nproviders:\n  - id: broken\n    kind: cli\n    adapter: codex\n    oauthToken: nope\n"
        )
        .is_err());
        assert!(parse_raw_config(
            "version: 2\nproviders:\n  - id: broken\n    kind: cli\n    adapter: claude\n    local: true\n"
        )
        .is_err());

        // A clean v2 config passes both legacy detection and full parsing.
        let clean = "version: 2\nproviders:\n  - id: openrouter\n    kind: openai_compatible\n";
        assert!(detect_legacy_format(clean).is_ok());
        assert!(parse_raw_config(clean).is_ok());
    }

    #[test]
    fn email_resolves_only_when_complete_and_supported() {
        // Complete Resend block, `to` as a scalar, camelCase apiKey.
        let cfg = Config::from_raw(
            serde_yaml::from_str(
                "services:\n  email:\n    provider: resend\n    apiKey: re_x\n    from: Alloy <a@b.com>\n    to: you@example.com\n",
            )
            .unwrap(),
        );
        let email = cfg.email.expect("email configured");
        assert_eq!(email.api_key, "re_x");
        assert_eq!(email.from, "Alloy <a@b.com>");
        assert_eq!(email.to, vec!["you@example.com"]);

        // `to` as a list.
        let cfg = Config::from_raw(
            serde_yaml::from_str(
                "services:\n  email:\n    provider: resend\n    apiKey: re_x\n    from: a@b.com\n    to: [one@x.com, two@x.com]\n",
            )
            .unwrap(),
        );
        assert_eq!(cfg.email.unwrap().to, vec!["one@x.com", "two@x.com"]);

        // Missing `to` → disabled.
        let cfg = Config::from_raw(
            serde_yaml::from_str(
                "services:\n  email:\n    provider: resend\n    apiKey: re_x\n    from: a@b.com\n",
            )
            .unwrap(),
        );
        assert!(cfg.email.is_none());

        // Unsupported provider → disabled.
        let cfg = Config::from_raw(
            serde_yaml::from_str(
                "services:\n  email:\n    provider: sendgrid\n    apiKey: sg\n    from: a@b.com\n    to: you@x.com\n",
            )
            .unwrap(),
        );
        assert!(cfg.email.is_none());
    }

    #[test]
    fn private_read_only_dirs_parse_alias_path_pairs() {
        let raw: RawConfig = serde_yaml::from_str(
            "privateReadOnlyDirs:\n  - alias: notes\n    path: /Users/x/Notes\n  - alias: journal\n    path: /Users/x/Journal\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        let dirs = &cfg.private_read_only_dirs;
        assert_eq!(dirs.len(), 2);
        assert_eq!(dirs[0].alias, "notes");
        assert_eq!(dirs[0].path, std::path::PathBuf::from("/Users/x/Notes"));
        assert_eq!(dirs[1].alias, "journal");
    }

    #[test]
    fn private_read_only_dirs_parse_exclude_dirs() {
        let raw: RawConfig = serde_yaml::from_str(
            "privateReadOnlyDirs:\n  - alias: obsidian\n    path: /Users/x/Notes\n    excludeDirs: [PromptBox, archive]\n",
        )
        .unwrap();
        let cfg = Config::from_raw(raw);
        let d = &cfg.private_read_only_dirs[0];
        assert_eq!(d.alias, "obsidian");
        assert_eq!(d.exclude_dirs, vec!["PromptBox", "archive"]);
    }

    #[test]
    fn compaction_camelcase_trigger_tokens() {
        let cfg = Config::from_raw(
            serde_yaml::from_str("compaction:\n  enabled: true\n  triggerTokens: 123000\n").unwrap(),
        );
        assert!(cfg.compaction.enabled);
        assert_eq!(cfg.compaction.trigger_tokens, 123000);
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
