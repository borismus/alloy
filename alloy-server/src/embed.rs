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
    tasks::scheduler::{spawn as spawn_scheduler, SchedulerHandle},
    vault::Vault,
};

/// Handle held by the Tauri shell to interact with the embedded server.
/// Held in Tauri's managed state and queried by command handlers.
pub struct EmbeddedServer {
    inner: Mutex<EmbeddedInner>,
}

#[derive(Default)]
struct EmbeddedInner {
    /// The base URL the SPA (inside the Tauri webview) hits. Always loopback,
    /// even when sharing is on (`0.0.0.0` binds include `127.0.0.1`).
    /// `None` until a vault has been bound.
    internal_url: Option<String>,
    /// Vault path currently in use, if any.
    vault_path: Option<PathBuf>,
    /// The single axum listener task. Same task whether share is on or off;
    /// `set_share` aborts it and rebinds with the new interface.
    listener_task: Option<JoinHandle<()>>,
    /// Most recent AppState (kept around so we can rebuild a router on
    /// rebind without rebuilding all the registries).
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

    /// Bind (or rebind) the listener using the given vault path.
    /// Returns the loopback URL.
    ///
    /// Idempotent on the same path: the SPA setup flow calls this twice in
    /// quick succession (once from `selectVaultFolder` so /api/fs/* works
    /// during the folder check, once from `loadVault` for the full mount),
    /// and naively rebuilding the AppState + tearing down the listener on
    /// the second call races against any in-flight HTTP request from the
    /// first. So we short-circuit when the same path is already bound.
    pub async fn set_vault(&self, vault_path: PathBuf) -> Result<String, EmbedError> {
        // Fast path: same vault already bound and serving.
        {
            let inner = self.inner.lock().unwrap();
            if let (Some(current), Some(url), true) = (
                inner.vault_path.as_ref(),
                inner.internal_url.as_ref(),
                inner.listener_task.is_some(),
            ) {
                if current == &vault_path {
                    return Ok(url.clone());
                }
            }
        }

        let state = build_app_state(&vault_path).await?;
        let config = state.config.clone();

        // Kick off the scheduled-task runner against this AppState. On a vault
        // swap we currently leave the old task orphaned with its old AppState;
        // vault swapping is manual and rare.
        spawn_scheduler(state.clone(), state.tasks.inflight.clone());

        // Stash state+config first so `bind_listener` can read share state
        // out of the cached config.
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(prev) = inner.listener_task.take() {
                prev.abort();
            }
            inner.vault_path = Some(vault_path);
            inner.state = Some(state);
            inner.config = Some(config);
        }

        let url = self.bind_listener().await?;
        Ok(url)
    }

    /// (Re)bind the single axum listener. Interface depends on share state:
    /// `0.0.0.0:<port>` when sharing is on, `127.0.0.1:<port>` otherwise.
    /// If the configured port is taken, falls back to a random loopback port
    /// — share-on requires the configured port (returns error).
    async fn bind_listener(&self) -> Result<String, EmbedError> {
        let (state, sharing, cfg_port) = {
            let inner = self.inner.lock().unwrap();
            let state = inner.state.clone().ok_or_else(|| {
                EmbedError::Config("cannot bind listener without a vault".into())
            })?;
            let cfg = inner.config.as_ref().cloned().unwrap_or_default();
            (state, cfg.share_on_network, cfg.share_port)
        };

        // ALLOY_EMBED_PORT overrides the configured port. `npm run tauri dev`
        // sets it so a dev build binds its own port instead of contending with
        // a production Alloy already holding the configured one (default 3001).
        let port = std::env::var("ALLOY_EMBED_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(cfg_port);

        let iface = if sharing { "0.0.0.0" } else { "127.0.0.1" };
        let primary_addr = format!("{}:{}", iface, port);

        // Try the configured port first; fall back to a random loopback port
        // only when share is off and the well-known port is taken (e.g. a
        // standalone alloy-serve already running). For shared sessions we
        // require the configured port so external clients have a stable URL.
        //
        // SO_REUSEADDR matters on a rebind: when we abort the prior task,
        // its TcpListener drops asynchronously and the kernel may still
        // hold the port for a moment. Without REUSEADDR the immediate
        // rebind fails with EADDRINUSE and we'd silently slip onto a
        // random port even though :3001 is about to be free.
        let listener = match bind_with_reuse(&primary_addr).await {
            Ok(l) => l,
            Err(e) if !sharing => {
                tracing::warn!(
                    "{} taken ({}); falling back to random loopback port. \
                     `npm run dev`'s vite /api proxy expects {} — close whatever is holding it.",
                    primary_addr, e, port
                );
                bind_with_reuse("127.0.0.1:0").await?
            }
            Err(e) => return Err(EmbedError::Bind(e)),
        };
        let bound = listener.local_addr()?;

        // The SPA in the Tauri webview — and the Claude Code MCP client we spawn
        // — always talk to loopback even when we bind 0.0.0.0 publicly.
        let internal_url = format!("http://127.0.0.1:{}", bound.port());
        if let Ok(mut slot) = state.self_base_url.write() {
            *slot = Some(internal_url.clone());
        }

        let app = build_router(state);
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!("axum serve exited: {}", e);
            }
        });

        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(prev) = inner.listener_task.take() {
                prev.abort();
            }
            inner.listener_task = Some(task);
            inner.internal_url = Some(internal_url.clone());
        }
        tracing::info!(
            "listener bound at http://{} (internal url: {})",
            bound, internal_url
        );
        Ok(internal_url)
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
            .config
            .as_ref()
            .map(|c| c.share_on_network)
            .unwrap_or(false)
    }

    /// The port the listener binds on.
    pub fn share_port(&self) -> u16 {
        self.inner
            .lock()
            .unwrap()
            .config
            .as_ref()
            .map(|c| c.share_port)
            .unwrap_or(3001)
    }

    /// Toggle network exposure. Persists the new value to the vault's
    /// `config.yaml`, then rebinds the listener on `0.0.0.0` (share on) or
    /// `127.0.0.1` (share off). Returns the loopback URL.
    pub async fn set_share(&self, enabled: bool) -> Result<Option<String>, EmbedError> {
        let vault_path = {
            let inner = self.inner.lock().unwrap();
            inner.vault_path.clone().ok_or_else(|| {
                EmbedError::Config("cannot toggle share before a vault is set".into())
            })?
        };

        // Persist to disk so the next launch remembers the setting.
        let config_path = vault_path.join("config.yaml");
        write_share_on_network(&config_path, enabled).map_err(EmbedError::from)?;

        // Update cached config and the live AtomicBool the request-time
        // middleware reads.
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(cfg) = inner.config.as_mut() {
                let mut new = (**cfg).clone();
                new.share_on_network = enabled;
                *cfg = Arc::new(new);
            }
            if let Some(state) = inner.state.as_ref() {
                state
                    .share_on_network
                    .store(enabled, std::sync::atomic::Ordering::Relaxed);
            }
        }

        let url = self.bind_listener().await?;
        Ok(if enabled { Some(url) } else { None })
    }
}

/// Construct the full AppState (vault, watcher, providers, tools, sessions,
/// model cache) for a given vault path. Mirrors the wiring in
/// `alloy-server/src/main.rs` for the standalone CLI.
async fn build_app_state(vault_path: &Path) -> Result<AppState, EmbedError> {
    let vault = Arc::new(Vault::new(vault_path.to_path_buf())?);

    let config_path = vault.root().join("config.yaml");
    let mut config = if config_path.exists() {
        Config::load(&config_path)?
    } else {
        tracing::warn!(
            "no config.yaml at {} — running with no providers",
            config_path.display()
        );
        Config::default()
    };
    // Enforce the external-only invariant on private read-only dirs (see main.rs).
    config.validate_private_dirs(vault.root());
    let config = Arc::new(config);

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
    let tasks = Arc::new(SchedulerHandle::new());
    let share_on_network = Arc::new(std::sync::atomic::AtomicBool::new(config.share_on_network));

    Ok(AppState {
        vault,
        watcher,
        providers,
        sessions,
        tools,
        config,
        share_on_network,
        model_cache,
        tasks,
        // Populated once the listener binds (see `bind_listener`).
        self_base_url: Arc::new(std::sync::RwLock::new(None)),
    })
}

/// Bind a TCP listener with SO_REUSEADDR set so a follow-up bind after
/// aborting a prior listener doesn't race the kernel's port-release.
async fn bind_with_reuse(addr: &str) -> std::io::Result<tokio::net::TcpListener> {
    let sock_addr: SocketAddr = addr.parse().map_err(|e: std::net::AddrParseError| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, e)
    })?;
    let socket = if sock_addr.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    socket.set_reuseaddr(true)?;
    socket.bind(sock_addr)?;
    socket.listen(1024)
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
