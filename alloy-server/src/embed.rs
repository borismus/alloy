//! Entry points for embedding alloy-server inside another process (Phase 2:
//! Tauri shell). Phase 1's `main.rs` standalone CLI stays as-is; this module
//! adds the bootstrap + handle types the Tauri side calls.
//!
//! Lifecycle:
//! 1. Tauri `setup` hook calls [`bootstrap_for_tauri`] with the previously
//!    remembered vault path (from localStorage). If `None`, the server is
//!    not bound yet — the SPA folder picker will provide it.
//! 2. Tauri command `get_server_url` returns the bound URL (or `None`).
//! 3. Tauri command `set_vault_path` calls [`EmbeddedServer::set_vault`],
//!    which spins up a fresh AppState + axum listener and returns the URL.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tokio::task::JoinHandle;

use crate::{
    AppState, build_router,
    config::{Config, write_share_on_network},
    providers::ProviderRegistry,
    routes::{models::ModelCache, watch::spawn_watcher},
    skill_registry::SkillRegistry,
    streaming::SessionRegistry,
    tools::ToolRegistry,
    triggers::scheduler::{spawn as spawn_scheduler, SchedulerHandle},
    vault::Vault,
};

/// Handle held by the Tauri shell to interact with the embedded server.
/// Held in Tauri's managed state and queried by command handlers.
pub struct EmbeddedServer {
    inner: Mutex<EmbeddedInner>,
}

#[derive(Default)]
struct EmbeddedInner {
    /// The base URL the SPA (inside the Tauri webview) should hit. Always
    /// loopback. `None` until a vault has been bound.
    internal_url: Option<String>,
    /// Vault path currently in use, if any.
    vault_path: Option<PathBuf>,
    /// Internal listener task; aborted on vault swap.
    internal_task: Option<JoinHandle<()>>,
    /// Public-facing listener (bound to 0.0.0.0:<sharePort>) when
    /// `shareOnNetwork` is on. Aborted on toggle-off or vault swap.
    public_task: Option<JoinHandle<()>>,
    /// Most recent AppState (kept around so the public listener can be
    /// (re)spawned with the same state when the share toggle flips).
    state: Option<AppState>,
    /// Cached effective config, kept in sync with config.yaml.
    config: Option<Arc<Config>>,
}

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("server bind failed: {0}")]
    Bind(#[from] std::io::Error),
    #[error("config error: {0}")]
    Config(String),
}

impl From<anyhow::Error> for EmbedError {
    fn from(e: anyhow::Error) -> Self {
        EmbedError::Config(e.to_string())
    }
}

impl EmbeddedServer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(EmbeddedInner::default()),
        })
    }

    /// Returns the current loopback URL the SPA should use, or `None` if
    /// no vault has been bound yet (first launch).
    pub fn internal_url(&self) -> Option<String> {
        self.inner.lock().unwrap().internal_url.clone()
    }

    pub fn current_vault_path(&self) -> Option<PathBuf> {
        self.inner.lock().unwrap().vault_path.clone()
    }

    /// Bind (or rebind) the internal listener using the given vault path.
    /// Returns the new URL. If a listener was already running, it's aborted.
    pub async fn set_vault(&self, vault_path: PathBuf) -> Result<String, EmbedError> {
        let state = build_app_state(&vault_path).await?;
        let config = state.config.clone();

        // Kick off the trigger scheduler against this AppState. Note: on a
        // vault rebind we leak the previous scheduler task — the AppState
        // it captured is now orphaned but harmless (it points at the old
        // vault and will keep ticking, but nothing reads its output).
        // Acceptable since vault rebinding is a manual user action.
        spawn_scheduler(state.clone(), state.triggers.inflight.clone());

        // Bind a fresh listener on a random loopback port.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let url = format!("http://{}", addr);

        let app = build_router(state.clone());
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!("internal axum serve exited: {}", e);
            }
        });

        // Atomically swap state + listener; abort prior listener(s).
        let public_should_run = config.share_on_network;
        let public_port = config.share_port;
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(prev) = inner.internal_task.take() {
                prev.abort();
            }
            if let Some(prev) = inner.public_task.take() {
                prev.abort();
            }
            inner.internal_task = Some(task);
            inner.internal_url = Some(url.clone());
            inner.vault_path = Some(vault_path);
            inner.state = Some(state);
            inner.config = Some(config);
        }

        // If `shareOnNetwork` was true in the loaded config, kick off the
        // public listener too. Failure here is non-fatal (Tauri webview
        // still works via the internal listener) but surfaces as a log.
        if public_should_run {
            if let Err(e) = self.spawn_public_listener(public_port).await {
                tracing::warn!("public listener failed to start: {}", e);
            }
        }

        Ok(url)
    }

    /// Bind (or rebind) the public listener on `0.0.0.0:<port>`. Aborts
    /// any existing one first. Returns the new URL on success.
    async fn spawn_public_listener(&self, port: u16) -> Result<String, EmbedError> {
        let state = {
            let inner = self.inner.lock().unwrap();
            inner.state.clone().ok_or_else(|| {
                EmbedError::Config("cannot start public listener without a vault".into())
            })?
        };

        let addr = format!("0.0.0.0:{}", port);
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        let bound = listener.local_addr()?;

        let app = build_router(state);
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!("public axum serve exited: {}", e);
            }
        });

        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(prev) = inner.public_task.take() {
                prev.abort();
            }
            inner.public_task = Some(task);
        }
        tracing::info!("public listener bound at http://{}", bound);
        Ok(format!("http://{}", bound))
    }

    /// True if vault is bound (required for sharing).
    pub fn has_vault(&self) -> bool {
        self.inner.lock().unwrap().vault_path.is_some()
    }

    /// Current shareOnNetwork state from loaded config; false if no vault yet.
    pub fn is_sharing(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .public_task
            .as_ref()
            .is_some()
    }

    /// The port the public listener was configured to bind on.
    pub fn share_port(&self) -> u16 {
        self.inner
            .lock()
            .unwrap()
            .config
            .as_ref()
            .map(|c| c.share_port)
            .unwrap_or(3001)
    }

    /// Toggle the public listener. Persists the new value to the vault's
    /// `config.yaml`. Returns the public URL when enabling, None when
    /// disabling.
    pub async fn set_share(&self, enabled: bool) -> Result<Option<String>, EmbedError> {
        let (vault_path, port) = {
            let inner = self.inner.lock().unwrap();
            let vault_path = inner.vault_path.clone().ok_or_else(|| {
                EmbedError::Config("cannot toggle share before a vault is set".into())
            })?;
            let port = inner
                .config
                .as_ref()
                .map(|c| c.share_port)
                .unwrap_or(3001);
            (vault_path, port)
        };

        // Persist to disk so the next launch remembers the setting.
        let config_path = vault_path.join("config.yaml");
        write_share_on_network(&config_path, enabled).map_err(EmbedError::from)?;

        // Update cached config.
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(cfg) = inner.config.as_mut() {
                let mut new = (**cfg).clone();
                new.share_on_network = enabled;
                *cfg = Arc::new(new);
            }
        }

        if enabled {
            let url = self.spawn_public_listener(port).await?;
            Ok(Some(url))
        } else {
            let mut inner = self.inner.lock().unwrap();
            if let Some(prev) = inner.public_task.take() {
                prev.abort();
            }
            Ok(None)
        }
    }
}

/// Construct the full AppState (vault, watcher, providers, tools, sessions,
/// model cache) for a given vault path. Mirrors the wiring in
/// `alloy-server/src/main.rs` for the standalone CLI.
async fn build_app_state(vault_path: &Path) -> Result<AppState, EmbedError> {
    let vault = Arc::new(Vault::new(vault_path.to_path_buf())?);

    let config_path = vault.root().join("config.yaml");
    let config = Arc::new(if config_path.exists() {
        Config::load(&config_path)?
    } else {
        tracing::warn!(
            "no config.yaml at {} — running with no providers",
            config_path.display()
        );
        Config::default()
    });

    let providers = ProviderRegistry::from_configs(&config.providers);
    let watcher = spawn_watcher(vault.clone())?;
    let sessions = SessionRegistry::new();

    let skills = Arc::new(SkillRegistry::new());
    skills.load(vault.root());

    let tools = Arc::new(ToolRegistry::new(
        config.clone(),
        vault.clone(),
        providers.clone(),
        skills.clone(),
    ));
    let model_cache = Arc::new(ModelCache::new());
    let triggers = Arc::new(SchedulerHandle::new());

    Ok(AppState {
        vault,
        watcher,
        providers,
        sessions,
        tools,
        config,
        model_cache,
        triggers,
    })
}

/// Convenience: Tauri shell calls this from `setup`. Reads the initial vault
/// path (from Tauri's persistent storage) and binds the listener if present.
/// On `None`, returns an empty handle; the SPA flow will call `set_vault`
/// later.
pub async fn bootstrap_for_tauri(
    initial_vault_path: Option<PathBuf>,
) -> Result<Arc<EmbeddedServer>, EmbedError> {
    let server = EmbeddedServer::new();
    if let Some(path) = initial_vault_path {
        match server.set_vault(path).await {
            Ok(url) => tracing::info!("embedded server bound at {}", url),
            Err(e) => tracing::error!("initial vault bind failed: {}", e),
        }
    } else {
        tracing::info!("embedded server started without a vault; awaiting set_vault");
    }
    Ok(server)
}
