use std::{net::SocketAddr, sync::Arc};

use alloy_server::{
    AppState, build_router, cli::Args, config::Config, providers::ProviderRegistry,
    routes::models::ModelCache, routes::watch::spawn_watcher, skill_registry::SkillRegistry,
    streaming::SessionRegistry, tools::ToolRegistry, vault::Vault,
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

    let state = AppState {
        vault,
        watcher,
        providers,
        sessions,
        tools,
        config,
        model_cache,
    };
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
