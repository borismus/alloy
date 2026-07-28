//! Local-vs-cloud model classification.
//!
//! "Local" means the user explicitly trusts that the model runs on their own
//! hardware and prompts never leave their network. Config v2 requires
//! `local: true`; URL shape alone never grants trust. The endpoint must also be
//! loopback/private-LAN so a mistaken flag cannot expose private notes to a
//! public service. This powers the model picker badge and private-dir access.
//!
//! CLI providers (`kind: cli`, adapter `claude` or `codex`) run a local process
//! but send prompts to the cloud, so they are never local.

use crate::config::{Config, ProviderConfig, ProviderKind};

/// Extract the bare host from a base URL (strip scheme, path, userinfo, port).
fn host_of(base_url: &str) -> &str {
    base_url
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
        .unwrap_or("")
}

/// True when `base_url` points at a loopback (127.0.0.1/localhost/::1/0.0.0.0)
/// or a `*.local` host. Conservative by design: a routable/self-hosted endpoint
/// is never mislabeled as local, so a `192.168.x`/`10.x` LAN IP counts as cloud
/// unless the provider is explicitly marked `local: true`.
pub fn is_local_url(base_url: &str) -> bool {
    if base_url.contains("[::1]") {
        return true;
    }
    let host = host_of(base_url);
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0") || host.ends_with(".local")
}

/// True when `base_url` is on a private/non-routable network: loopback, `*.local`,
/// or an RFC-1918 / link-local LAN address. Used only as the safety rail for an
/// explicit `local: true` — a public URL with `local: true` is refused so a
/// copy-paste mistake can't ship private notes to the cloud.
fn is_private_network_url(base_url: &str) -> bool {
    if is_local_url(base_url) {
        return true;
    }
    let host = host_of(base_url);
    host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host.ends_with(".lan")
        || host.ends_with(".home")
        || host
            .strip_prefix("172.")
            .and_then(|rest| rest.split('.').next())
            .and_then(|octet| octet.parse::<u8>().ok())
            .is_some_and(|n| (16..=31).contains(&n))
}

/// Whether a single provider is explicitly trusted as local.
///
/// - CLI adapters are never local (local process, cloud data).
/// - Only `local: true` can grant trust; false or omitted is cloud.
/// - The explicit flag is still refused without a private-network `baseUrl`, so
///   a typo cannot mark the default public OpenRouter endpoint as local.
pub fn provider_is_local(p: &ProviderConfig) -> bool {
    if p.kind != ProviderKind::OpenaiCompatible || p.local != Some(true) {
        return false;
    }
    match p.base_url.as_deref() {
        Some(url) if is_private_network_url(url) => true,
        Some(url) => {
            tracing::warn!(
                "provider '{}' is marked local: true but has a public baseUrl ({}) — treating as cloud",
                p.id,
                url
            );
            false
        }
        None => {
            tracing::warn!(
                "provider '{}' is marked local: true but has no baseUrl — treating as cloud",
                p.id
            );
            false
        }
    }
}

/// True when the provider serving `model_id` (a `provider/model` id) is local.
///
/// Resolves the provider the same way [`crate::providers::ProviderRegistry::resolve`]
/// does — the prefix before the first `/` if it matches a configured provider id,
/// otherwise the default (first configured) provider — then classifies it via
/// [`provider_is_local`].
pub fn model_is_local(config: &Config, model_id: &str) -> bool {
    let prefix = model_id.split_once('/').map(|(p, _)| p);
    let provider = match prefix {
        Some(p) if config.providers.iter().any(|c| c.id == p) => {
            config.providers.iter().find(|c| c.id == p)
        }
        _ => config.providers.first(),
    };
    provider.map(provider_is_local).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CliAdapter, ProviderConfig, ProviderKind};

    #[test]
    fn local_url_detects_loopback_and_dot_local_only() {
        assert!(is_local_url("http://127.0.0.1:8000/v1"));
        assert!(is_local_url("http://localhost:11434"));
        assert!(is_local_url("http://[::1]:8000/v1"));
        assert!(is_local_url("http://my-mac.local:8000/v1"));
        // Remote / self-hosted endpoints must NOT be labeled local by URL alone.
        assert!(!is_local_url("https://openrouter.ai/api/v1"));
        assert!(!is_local_url("http://192.168.1.50:8000/v1"));
        assert!(!is_local_url("http://10.0.0.4:8000/v1"));
    }

    #[test]
    fn private_network_url_covers_rfc1918_and_link_local() {
        assert!(is_private_network_url("http://192.168.1.50:8000/v1"));
        assert!(is_private_network_url("http://10.0.0.4:8000/v1"));
        assert!(is_private_network_url("http://172.16.0.9:8000/v1"));
        assert!(is_private_network_url("http://172.31.255.1:8000/v1"));
        assert!(is_private_network_url("http://my-mac.local:8000/v1"));
        assert!(!is_private_network_url("http://172.32.0.1:8000/v1")); // outside 16-31
        assert!(!is_private_network_url("https://openrouter.ai/api/v1"));
    }

    fn provider(
        id: &str,
        base_url: Option<&str>,
        kind: ProviderKind,
        local: Option<bool>,
    ) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            kind,
            adapter: (kind == ProviderKind::Cli).then_some(CliAdapter::Claude),
            base_url: base_url.map(str::to_string),
            api_key: String::new(),
            command: None,
            oauth_token: None,
            local,
        }
    }

    fn config_with(providers: Vec<ProviderConfig>) -> Config {
        Config {
            providers,
            ..Config::default()
        }
    }

    #[test]
    fn model_is_local_requires_explicit_trust() {
        let cfg = config_with(vec![
            provider("mlx", Some("http://smus-m4.local:8000/v1"), ProviderKind::OpenaiCompatible, Some(true)),
            provider("untrusted-localhost", Some("http://localhost:8000/v1"), ProviderKind::OpenaiCompatible, None),
            provider("openrouter", Some("https://openrouter.ai/api/v1"), ProviderKind::OpenaiCompatible, None),
            provider("claude-cli", None, ProviderKind::Cli, None),
        ]);
        assert!(model_is_local(&cfg, "mlx/gemma4"));
        assert!(!model_is_local(&cfg, "untrusted-localhost/model"));
        assert!(!model_is_local(&cfg, "openrouter/anthropic/claude-sonnet-5"));
        assert!(!model_is_local(&cfg, "claude-cli/opus"));
    }

    #[test]
    fn explicit_local_flag_trusts_private_network_endpoint() {
        // A LAN IP is cloud by URL heuristic, but an explicit local: true is honored.
        let cfg = config_with(vec![provider(
            "mlx",
            Some("http://192.168.1.50:8000/v1"),
            ProviderKind::OpenaiCompatible,
            Some(true),
        )]);
        assert!(model_is_local(&cfg, "mlx/Qwen3"));
    }

    #[test]
    fn explicit_local_true_refused_on_public_url() {
        // Safety rail: local: true on a public host is refused (treated as cloud).
        let cfg = config_with(vec![provider(
            "sketchy",
            Some("https://openrouter.ai/api/v1"),
            ProviderKind::OpenaiCompatible,
            Some(true),
        )]);
        assert!(!model_is_local(&cfg, "sketchy/x"));
    }

    #[test]
    fn omitted_or_explicit_false_is_cloud() {
        let cfg = config_with(vec![provider(
            "mlx",
            Some("http://localhost:8000/v1"),
            ProviderKind::OpenaiCompatible,
            Some(false),
        )]);
        assert!(!model_is_local(&cfg, "mlx/x"));

        let omitted = config_with(vec![provider(
            "mlx",
            Some("http://localhost:8000/v1"),
            ProviderKind::OpenaiCompatible,
            None,
        )]);
        assert!(!model_is_local(&omitted, "mlx/x"));
    }

    #[test]
    fn explicit_local_true_without_endpoint_is_refused() {
        let cfg = config_with(vec![provider(
            "openrouter",
            None,
            ProviderKind::OpenaiCompatible,
            Some(true),
        )]);
        assert!(!model_is_local(&cfg, "openrouter/x"));
    }

    #[test]
    fn cli_adapters_are_never_local_even_if_flagged() {
        let cfg = config_with(vec![provider(
            "claude",
            None,
            ProviderKind::Cli,
            Some(true),
        )]);
        assert!(!model_is_local(&cfg, "claude/opus"));
    }

    #[test]
    fn unknown_prefix_falls_back_to_default_provider() {
        let local_default = config_with(vec![provider(
            "mlx",
            Some("http://localhost:8000/v1"),
            ProviderKind::OpenaiCompatible,
            Some(true),
        )]);
        assert!(model_is_local(&local_default, "some-bare-model"));

        let cloud_default = config_with(vec![provider(
            "openrouter",
            Some("https://openrouter.ai/api/v1"),
            ProviderKind::OpenaiCompatible,
            None,
        )]);
        assert!(!model_is_local(&cloud_default, "some-bare-model"));
    }

    #[test]
    fn empty_providers_is_not_local() {
        assert!(!model_is_local(&config_with(vec![]), "openrouter/some-model"));
    }
}
