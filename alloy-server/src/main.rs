use std::{
    net::SocketAddr,
    sync::{Arc, atomic::AtomicBool},
};

use alloy_server::{
    AppState, build_router, cli::Args, config::Config, providers::ProviderRegistry,
    routes::models::ModelCache, routes::watch::spawn_watcher, skill_registry::SkillRegistry,
    streaming::SessionRegistry, tools::ToolRegistry,
    triggers::scheduler::{spawn as spawn_scheduler, SchedulerHandle},
    vault::Vault,
};
use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let args = Args::parse();

    tracing::info!("vault: {}", args.vault.display());
    let vault = Arc::new(Vault::new(args.vault.clone()).map_err(|e| {
        anyhow::anyhow!(
            "Failed to open vault {}: {}",
            args.vault.display(),
            e
        )
    })?);

    let config_path = vault.root().join("config.yaml");
    let config = if config_path.exists() {
        Config::load(&config_path)?
    } else {
        tracing::warn!(
            "no config.yaml at {} — running with no providers",
            config_path.display()
        );
        Config::default()
    };
    let config = Arc::new(config);

    let providers = ProviderRegistry::from_configs(&config.providers);

    // Surface a stale `defaultModel` at startup so the operator sees it before
    // the first stream attempt fails. We only warn — the SPA can still pick a
    // different model from /api/models.
    if let Some(model) = &config.default_model {
        if let Err(msg) = providers.resolve(model) {
            tracing::warn!("defaultModel won't resolve: {}", msg);
        }
    }
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

    let share_on_network = Arc::new(AtomicBool::new(config.share_on_network));

    let state = AppState {
        vault,
        watcher,
        providers,
        sessions,
        tools,
        config,
        share_on_network,
        model_cache,
        triggers: triggers.clone(),
    };

    // Background trigger scheduler: fires regardless of client presence.
    spawn_scheduler(state.clone(), triggers.inflight.clone());

    let app = build_router(state);

    let bind: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid bind address {}:{} — {}", args.host, args.port, e))?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
