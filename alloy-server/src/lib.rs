//! Alloy server backend.
//!
//! Phase 1 ships this as a standalone CLI binary (`alloy-serve`); the library
//! surface is kept minimal so the same code can later be embedded into the
//! Tauri shell as a sidecar/in-process server (Phase 2).

pub mod auth;
pub mod cli;
pub mod config;
pub mod embed;
pub mod error;
pub mod providers;
pub mod routes;
pub mod skill_registry;
pub mod streaming;
pub mod tool_loop;
pub mod tools;
pub mod types;
pub mod vault;
pub mod vault_writer;

use std::sync::Arc;

use axum::Router;
use tower_http::cors::CorsLayer;

use crate::config::Config;
use crate::providers::ProviderRegistry;
use crate::routes::models::ModelCache;
use crate::routes::watch::WatcherChannel;
use crate::streaming::SessionRegistry;
use crate::tools::ToolRegistry;
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
    pub model_cache: Arc<ModelCache>,
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
        // SPA static assets are a FALLBACK — they only run for paths with
        // no declared route. Using a fallback instead of a /{*path}
        // catch-all means OPTIONS preflight on /api/* paths doesn't end up
        // returning 405 (which would block the actual POST in WKWebView).
        .fallback(routes::static_files::fallback)
        .layer(axum::middleware::from_fn(auth::ip_allowlist))
        .layer(cors)
        .with_state(state)
}
