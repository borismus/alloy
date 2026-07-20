//! Local-vs-cloud model classification.
//!
//! "Local" means the model runs on the user's own or otherwise trusted
//! hardware — a loopback endpoint (prompts never leave the device) or a
//! `*.local` LAN box. This is the same rule that powers the model picker's
//! "Local" privacy badge (`GET /api/models`), and it gates read access to the
//! private note directories (see `tools::private`).

use crate::config::Config;

/// True when `base_url` points at a loopback (127.0.0.1/localhost/::1/0.0.0.0)
/// or a `*.local` host. Conservative by design: a routable/self-hosted endpoint
/// is never mislabeled as local, so a `192.168.x`/`10.x` LAN IP counts as cloud.
pub fn is_local_url(base_url: &str) -> bool {
    if base_url.contains("[::1]") {
        return true;
    }
    let host = base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0") || host.ends_with(".local")
}

/// True when the provider serving `model_id` (a `provider/model` id) is local.
///
/// Resolves the provider the same way [`crate::providers::ProviderRegistry::resolve`]
/// does — the prefix before the first `/` if it matches a configured provider id,
/// otherwise the default (first configured) provider — then classifies its
/// `base_url`. The `cli_claude` kind has no `base_url`, so it is never local.
pub fn model_is_local(config: &Config, model_id: &str) -> bool {
    let prefix = model_id.split_once('/').map(|(p, _)| p);
    // oMLX is an on-device server by definition; treat it as local even when
    // its endpoint isn't loopback/`.local` or is currently unreachable. Mirrors
    // the frontend `isLocalModel` badge rule.
    if prefix == Some("mlx") {
        return true;
    }
    let provider = match prefix {
        Some(p) if config.providers.iter().any(|c| c.id == p) => {
            config.providers.iter().find(|c| c.id == p)
        }
        _ => config.providers.first(),
    };
    provider
        .and_then(|p| p.base_url.as_deref())
        .map(is_local_url)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProviderConfig, ProviderKind};

    #[test]
    fn local_url_detects_loopback_and_dot_local_only() {
        assert!(is_local_url("http://127.0.0.1:8000/v1"));
        assert!(is_local_url("http://localhost:11434"));
        assert!(is_local_url("http://[::1]:8000/v1"));
        assert!(is_local_url("http://my-mac.local:8000/v1"));
        // Remote / self-hosted endpoints must NOT be labeled local.
        assert!(!is_local_url("https://openrouter.ai/api/v1"));
        assert!(!is_local_url("http://192.168.1.50:8000/v1"));
        assert!(!is_local_url("http://10.0.0.4:8000/v1"));
    }

    fn provider(id: &str, base_url: Option<&str>, kind: ProviderKind) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            kind,
            base_url: base_url.map(str::to_string),
            api_key: String::new(),
            command: None,
            oauth_token: None,
        }
    }

    fn config_with(providers: Vec<ProviderConfig>) -> Config {
        Config {
            providers,
            ..Config::default()
        }
    }

    #[test]
    fn model_is_local_classifies_by_provider_base_url() {
        let cfg = config_with(vec![
            provider("mlx", Some("http://smus-m4.local:8000/v1"), ProviderKind::OpenaiCompatible),
            provider("ollama", Some("http://localhost:11434/v1"), ProviderKind::OpenaiCompatible),
            provider("openrouter", Some("https://openrouter.ai/api/v1"), ProviderKind::OpenaiCompatible),
            provider("claude-cli", None, ProviderKind::CliClaude),
        ]);
        assert!(model_is_local(&cfg, "mlx/gemma4"));
        assert!(model_is_local(&cfg, "ollama/llama3"));
        assert!(!model_is_local(&cfg, "openrouter/anthropic/claude-sonnet-5"));
        assert!(!model_is_local(&cfg, "claude-cli/opus"));
    }

    #[test]
    fn mlx_is_always_local_even_with_routable_endpoint() {
        // mlx pointed at a routable IP still counts as local (on-device by
        // definition), and works even when the provider isn't configured here.
        let cfg = config_with(vec![provider(
            "mlx",
            Some("http://203.0.113.7:8000/v1"),
            ProviderKind::OpenaiCompatible,
        )]);
        assert!(model_is_local(&cfg, "mlx/Qwen3"));
        assert!(model_is_local(&config_with(vec![]), "mlx/Qwen3"));
    }

    #[test]
    fn unknown_prefix_falls_back_to_default_provider() {
        // First configured provider is the default; a bare/unknown-prefix model
        // id inherits its locality.
        let local_default = config_with(vec![provider(
            "mlx",
            Some("http://localhost:8000/v1"),
            ProviderKind::OpenaiCompatible,
        )]);
        assert!(model_is_local(&local_default, "some-bare-model"));

        let cloud_default = config_with(vec![provider(
            "openrouter",
            Some("https://openrouter.ai/api/v1"),
            ProviderKind::OpenaiCompatible,
        )]);
        assert!(!model_is_local(&cloud_default, "some-bare-model"));
    }

    #[test]
    fn empty_providers_is_not_local() {
        // A non-mlx model with no providers configured can't be local. (mlx is
        // special-cased as always-local; see the dedicated test above.)
        assert!(!model_is_local(&config_with(vec![]), "openrouter/some-model"));
    }
}
