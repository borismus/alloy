//! Alloy server backend.
//!
//! Phase 1 ships this as a standalone CLI binary (`alloy-serve`); the library
//! surface is kept minimal so the same code can later be embedded into the
//! Tauri shell as a sidecar/in-process server (Phase 2).

pub mod auth;
pub mod cli;
pub mod compaction;
pub mod config;
pub mod embed;
pub mod error;
pub mod local;
pub mod providers;
pub mod routes;
pub mod skill_registry;
pub mod streaming;
pub mod tool_loop;
pub mod tools;
pub mod triggers;
pub mod types;
pub mod vault;
pub mod vault_writer;

use std::sync::{Arc, RwLock, atomic::AtomicBool};

use axum::{Router, extract::DefaultBodyLimit};
use tower_http::cors::CorsLayer;

use crate::config::Config;
use crate::providers::ProviderRegistry;
use crate::routes::models::ModelCache;
use crate::routes::watch::WatcherChannel;
use crate::streaming::SessionRegistry;
use crate::tools::ToolRegistry;
use crate::triggers::scheduler::SchedulerHandle;
use crate::vault::Vault;

/// Shared application state available to every handler.
#[derive(Clone)]
pub struct AppState {
    pub vault: Arc<Vault>,
    pub watcher: WatcherChannel,
    pub providers: ProviderRegistry,
    pub sessions: SessionRegistry,
    pub tools: Arc<ToolRegistry>,
    pub config: Arc<Config>,
    /// Live mirror of `config.shareOnNetwork`. Read by the share-gate
    /// middleware on every request so toggling the share UI takes effect
    /// without rebuilding state. `embed::set_share` flips this in lockstep
    /// with the listener rebind.
    pub share_on_network: Arc<AtomicBool>,
    pub model_cache: Arc<ModelCache>,
    /// Holds the scheduler's "currently running" set so the `/run` route
    /// and the background tick don't double-fire the same trigger.
    pub triggers: Arc<SchedulerHandle>,
    /// This server's own loopback base URL (e.g. `http://127.0.0.1:3001`), set
    /// once the listener binds. The `claude-cli` provider needs it to point the
    /// Claude Code MCP client back at our `/api/mcp` endpoint. `None` until bound.
    pub self_base_url: Arc<RwLock<Option<String>>>,
}

pub fn build_router(state: AppState) -> Router {
    // `very_permissive` mirrors the request origin (rather than `*`) and
    // permits credentials, methods, and headers freely. This matters in
    // WKWebView (Tauri's webview on macOS) which is stricter than Chrome
    // about how CORS preflight responses are shaped.
    let cors = CorsLayer::very_permissive();

    Router::new()
        .merge(routes::fs::router())
        .merge(routes::path::router())
        .merge(routes::watch::router())
        .merge(routes::stream::router())
        .merge(routes::models::router())
        .merge(routes::triggers::router())
        .merge(routes::mcp::router())
        // SPA static assets are a FALLBACK — they only run for paths with
        // no declared route. Using a fallback instead of a /{*path}
        // catch-all means OPTIONS preflight on /api/* paths doesn't end up
        // returning 405 (which would block the actual POST in WKWebView).
        .fallback(routes::static_files::fallback)
        .layer(axum::middleware::from_fn_with_state(
            state.share_on_network.clone(),
            auth::tailscale_share_gate,
        ))
        .layer(axum::middleware::from_fn(auth::ip_allowlist))
        .layer(cors)
        // Raise the request-body cap above axum's ~2MB default so image uploads
        // (base64 in JSON, ~33% larger than the raw bytes) aren't rejected with
        // 413 before the handler runs. Oversized images are downscaled at write
        // time (see routes::fs::write_file); text/stream bodies stay small.
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(state)
}
