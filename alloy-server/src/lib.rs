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
use tower_http::cors::{Any, CorsLayer};

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
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .merge(routes::fs::router())
        .merge(routes::path::router())
        .merge(routes::watch::router())
        .merge(routes::stream::router())
        .merge(routes::models::router())
        // Static SPA assets — listed LAST so /api/* and /api/watch route
        // before the catch-all /{*path} handler in static_files.
        .merge(routes::static_files::router())
        .layer(axum::middleware::from_fn(auth::ip_allowlist))
        .layer(cors)
        .with_state(state)
}
