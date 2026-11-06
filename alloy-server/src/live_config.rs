//! Keeps a running server in step with `config.yaml`.
//!
//! Everything derived from the config lives in one immutable [`ConfigSnapshot`]
//! that [`LiveConfig`] swaps whole. A turn takes a snapshot when it starts and
//! keeps it, so a change applies from the next turn and never half-way through
//! one. Reads are always a coherent set: a key and the provider built from it
//! cannot come from different versions of the file.
//!
//! [`spawn_reloader`] drives the swap from the vault watcher, so a hand edit or
//! a sync takes effect without a restart. A file that can't be applied (broken
//! YAML, or missing mid-sync) leaves the last good config running.
//!
//! The listener is the exception: `shareOnNetwork` and `sharePort` keep their
//! values until restart. The config syncs between machines, and an edit on one
//! must not silently change what another exposes to its network.

use std::{
    path::Path,
    sync::{Arc, RwLock, atomic::Ordering},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    sync::broadcast::{self, error::RecvError},
    task::JoinHandle,
};

use crate::{
    AppState, config::Config, providers::ProviderRegistry, skill_registry::SkillRegistry,
    tools::ToolRegistry, vault::Vault,
};

/// Wait after the first event: a save or a sync arrives as a burst of events,
/// and reading mid-write could parse a truncated file that is still valid YAML.
const RELOAD_SETTLE: Duration = Duration::from_millis(200);

/// One version of `config.yaml` and everything built from it.
pub struct ConfigSnapshot {
    pub config: Arc<Config>,
    pub providers: ProviderRegistry,
    pub tools: Arc<ToolRegistry>,
}

impl ConfigSnapshot {
    pub fn build(config: Config, vault: Arc<Vault>, skills: Arc<SkillRegistry>) -> Self {
        let config = Arc::new(config);
        let providers = ProviderRegistry::from_configs(&config.providers);
        let tools = Arc::new(ToolRegistry::new(
            config.clone(),
            vault,
            providers.clone(),
            skills,
        ));
        Self {
            config,
            providers,
            tools,
        }
    }
}

/// The server's current [`ConfigSnapshot`].
pub struct LiveConfig {
    current: RwLock<Arc<ConfigSnapshot>>,
}

impl LiveConfig {
    pub fn new(snapshot: ConfigSnapshot) -> Self {
        Self {
            current: RwLock::new(Arc::new(snapshot)),
        }
    }

    /// The current version. Take it once per unit of work and hold on to it.
    pub fn snapshot(&self) -> Arc<ConfigSnapshot> {
        self.current.read().unwrap().clone()
    }

    fn replace(&self, snapshot: ConfigSnapshot) {
        *self.current.write().unwrap() = Arc::new(snapshot);
    }
}

/// Read the config at startup. Unlike a reload there is nothing to fall back
/// on, so a bad file is an error and a missing one means no providers.
pub fn load_config(vault_root: &Path) -> anyhow::Result<Config> {
    let path = vault_root.join("config.yaml");
    let mut config = if path.exists() {
        Config::load(&path)?
    } else {
        tracing::warn!(
            "no config.yaml at {} — running with no providers",
            path.display()
        );
        Config::default()
    };
    // Enforce the external-only invariant on private read-only dirs now that the
    // vault root is known (drops misconfigured entries with a warning).
    config.validate_private_dirs(vault_root);
    Ok(config)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReloadOutcome {
    /// A new snapshot is live.
    Applied,
    /// The file changed but no setting the server uses did (a favorites edit).
    Unchanged,
    /// The file can't be applied; the previous config stays live.
    Rejected,
}

/// Apply the on-disk config. Synchronous because it does file I/O and probes
/// CLI install locations; [`spawn_reloader`] runs it off the async workers.
pub(crate) fn reload(state: &AppState) -> ReloadOutcome {
    let root = state.vault.root();
    let mut next = match Config::load(&root.join("config.yaml")) {
        Ok(config) => config,
        Err(e) => {
            tracing::error!("config.yaml not applied, keeping the previous config: {e:#}");
            return ReloadOutcome::Rejected;
        }
    };
    next.validate_private_dirs(root);

    let current = state.live.snapshot();
    if next == *current.config {
        return ReloadOutcome::Unchanged;
    }

    let sharing = state.share_on_network.load(Ordering::Relaxed);
    if next.share_on_network != sharing || next.share_port != current.config.share_port {
        tracing::warn!("shareOnNetwork/sharePort changed in config.yaml; restart Alloy to apply");
    }

    // A catalog discovered with an old key or URL says nothing about the new one.
    let stale_providers = current
        .config
        .providers
        .iter()
        .filter(|old| !next.providers.contains(old));
    for provider in stale_providers {
        state.model_cache.invalidate_provider(&provider.id);
    }

    state.live.replace(ConfigSnapshot::build(
        next,
        state.vault.clone(),
        current.tools.skills.clone(),
    ));
    tracing::info!("config.yaml reloaded");

    // Clients refetch on the file's own event, which beats this reload by the
    // settle time and so sees the old catalog. Announce that it's now live. This
    // comes back through `spawn_reloader` and stops there: unchanged, no event.
    let _ = state.watcher.0.send(json!({
        "type": { "modify": { "kind": "data" } },
        "paths": ["config.yaml"],
    }));
    ReloadOutcome::Applied
}

/// Reload whenever the vault's `config.yaml` changes. The handle lets a vault
/// switch stop the task along with the rest of the old vault's background work.
pub fn spawn_reloader(state: AppState) -> JoinHandle<()> {
    let events = state.watcher.0.subscribe();
    tokio::spawn(reload_loop(state, events))
}

async fn reload_loop(state: AppState, mut events: broadcast::Receiver<Value>) {
    loop {
        match events.recv().await {
            Ok(event) if touches_config(&event) => {}
            Ok(_) => continue,
            // Events were dropped; one of them may have been a config change.
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => break,
        }
        tokio::time::sleep(RELOAD_SETTLE).await;
        // Whatever queued up meanwhile is covered by the reload below.
        while events.try_recv().is_ok() {}
        let state = state.clone();
        let _ = tokio::task::spawn_blocking(move || reload(&state)).await;
    }
}

/// A watcher event for the vault's own `config.yaml`, not a same-named file
/// elsewhere in the vault or a `config.yaml.pre-0.4.bak` backup beside it.
fn touches_config(event: &Value) -> bool {
    event
        .get("paths")
        .and_then(Value::as_array)
        .is_some_and(|paths| paths.iter().any(|p| p.as_str() == Some("config.yaml")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "version: 2\nserperApiKey: old-key\nproviders: []\n";
    const WITH_MLX: &str = "version: 2\nproviders:\n  - id: mlx\n    kind: openai_compatible\n    \
                            baseUrl: http://localhost:8000/v1\n    apiKey: first\n    local: true\n";

    struct Fixture {
        dir: tempfile::TempDir,
        state: AppState,
    }

    impl Fixture {
        async fn new(config: &str) -> Self {
            // Not `tempdir()`: its `.tmp` prefix is a dotfile to the vault watcher.
            let dir = tempfile::Builder::new().prefix("alloy-vault").tempdir().unwrap();
            std::fs::write(dir.path().join("config.yaml"), config).unwrap();
            let state = crate::embed::build_app_state(dir.path()).await.unwrap();
            Self { dir, state }
        }

        fn write(&self, config: &str) {
            std::fs::write(self.dir.path().join("config.yaml"), config).unwrap();
        }

        fn serper_key(&self) -> Option<String> {
            self.state.live.snapshot().config.serper_api_key.clone()
        }
    }

    /// The bug this module exists for: a key rotated on disk stayed unused until
    /// someone restarted the server. Goes through the real file watcher.
    #[tokio::test]
    async fn a_change_on_disk_reaches_a_running_server() {
        let fixture = Fixture::new(BASE).await;
        let reloader = spawn_reloader(fixture.state.clone());

        fixture.write("version: 2\nserperApiKey: new-key\nproviders: []\n");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let key = fixture.state.live.snapshot().tools.config.serper_api_key.clone();
            if key.as_deref() == Some("new-key") {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "web_search's registry never saw the new key: {key:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        reloader.abort();
    }

    #[tokio::test]
    async fn a_running_turn_keeps_its_snapshot_and_the_next_one_sees_the_change() {
        let fixture = Fixture::new(BASE).await;
        let running_turn = fixture.state.live.snapshot();

        fixture.write(WITH_MLX);
        assert_eq!(reload(&fixture.state), ReloadOutcome::Applied);

        assert!(running_turn.providers.resolve("mlx/model").is_err());
        assert_eq!(running_turn.tools.config.serper_api_key.as_deref(), Some("old-key"));

        let next_turn = fixture.state.live.snapshot();
        assert!(next_turn.providers.resolve("mlx/model").is_ok());
        assert_eq!(next_turn.tools.config.serper_api_key, None);
    }

    #[tokio::test]
    async fn a_file_that_cannot_be_applied_leaves_the_last_good_config_running() {
        let fixture = Fixture::new(BASE).await;
        let mut events = fixture.state.watcher.0.subscribe();

        for broken in [
            "version: [unterminated",
            "providers: []\n",                 // no `version: 2`
            "version: 2\nOPENROUTER_API_KEY: x\n", // pre-0.4 flat keys
        ] {
            fixture.write(broken);
            assert_eq!(reload(&fixture.state), ReloadOutcome::Rejected, "{broken}");
            assert_eq!(fixture.serper_key().as_deref(), Some("old-key"), "{broken}");
        }

        // A sync can replace the file by deleting it first.
        std::fs::remove_file(fixture.dir.path().join("config.yaml")).unwrap();
        assert_eq!(reload(&fixture.state), ReloadOutcome::Rejected);
        assert_eq!(fixture.serper_key().as_deref(), Some("old-key"));

        assert!(events.try_recv().is_err(), "a rejected file announces nothing");
    }

    #[tokio::test]
    async fn an_edit_the_server_does_not_use_changes_nothing() {
        let fixture = Fixture::new(WITH_MLX).await;
        let before = fixture.state.live.snapshot();
        fixture
            .state
            .model_cache
            .set_provider("mlx", Vec::new(), Duration::from_secs(60));
        let mut events = fixture.state.watcher.0.subscribe();

        fixture.write(&format!("{WITH_MLX}favoriteModels:\n  - mlx/model\n"));

        assert_eq!(reload(&fixture.state), ReloadOutcome::Unchanged);
        assert!(Arc::ptr_eq(&before, &fixture.state.live.snapshot()));
        assert!(fixture.state.model_cache.get_provider("mlx").is_some());
        assert!(events.try_recv().is_err(), "must not re-trigger the reload loop");
    }

    #[tokio::test]
    async fn clients_hear_about_a_reload_once_it_is_live() {
        let fixture = Fixture::new(BASE).await;
        let mut events = fixture.state.watcher.0.subscribe();

        fixture.write(WITH_MLX);
        reload(&fixture.state);

        let event = events.try_recv().expect("an announcement");
        assert!(touches_config(&event));
        assert_eq!(event["type"]["modify"]["kind"], "data");
    }

    #[tokio::test]
    async fn only_changed_providers_lose_their_cached_models() {
        let two_providers = format!(
            "{WITH_MLX}  - id: lan\n    kind: openai_compatible\n    \
             baseUrl: http://localhost:9000/v1\n    apiKey: lan-key\n    local: true\n"
        );
        let fixture = Fixture::new(&two_providers).await;
        let cache = &fixture.state.model_cache;
        cache.set_provider("mlx", Vec::new(), Duration::from_secs(60));
        cache.set_provider("lan", Vec::new(), Duration::from_secs(60));

        fixture.write(&two_providers.replace("apiKey: first", "apiKey: rotated"));
        assert_eq!(reload(&fixture.state), ReloadOutcome::Applied);

        assert!(cache.get_provider("mlx").is_none());
        assert!(cache.get_provider("lan").is_some());
    }

    /// `privateReadOnlyDirs` must stay outside the vault or a local model could
    /// read `config.yaml` through a mount. A reload is a second way in.
    #[tokio::test]
    async fn a_reload_still_drops_private_dirs_inside_the_vault() {
        let fixture = Fixture::new(BASE).await;
        let inside = fixture.state.vault.root().join("notes");
        std::fs::create_dir(&inside).unwrap();

        fixture.write(&format!(
            "version: 2\nproviders: []\nprivateReadOnlyDirs:\n  - alias: notes\n    path: {}\n",
            inside.display()
        ));
        assert_eq!(reload(&fixture.state), ReloadOutcome::Applied);

        assert!(fixture.state.live.snapshot().config.private_read_only_dirs.is_empty());
    }

    #[tokio::test]
    async fn a_synced_share_change_does_not_expose_the_server() {
        let fixture = Fixture::new(BASE).await;

        fixture.write("version: 2\nshareOnNetwork: true\nproviders: []\n");
        assert_eq!(reload(&fixture.state), ReloadOutcome::Applied);

        assert!(!fixture.state.share_on_network.load(Ordering::Relaxed));
    }

    #[test]
    fn only_the_vault_root_config_counts() {
        let event = |path: &str| json!({ "paths": [path] });
        assert!(touches_config(&event("config.yaml")));
        assert!(!touches_config(&event("notes/config.yaml")));
        assert!(!touches_config(&event("config.yaml.pre-0.4.bak")));
        assert!(!touches_config(&json!({ "type": "other" })));
    }
}
