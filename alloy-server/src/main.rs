use std::{
    net::SocketAddr,
    sync::{Arc, atomic::AtomicBool},
};

use alloy_server::{
    AppState, build_router, cli::Args, config::Config, providers::ProviderRegistry,
    routes::models::ModelCache, routes::watch::spawn_watcher, skill_registry::SkillRegistry,
    streaming::SessionRegistry, tools::ToolRegistry,
    tasks::scheduler::{spawn as spawn_scheduler, SchedulerHandle},
    vault::Vault,
};
use clap::Parser;

/// Report, and optionally apply, `private: true` for conversations whose
/// persisted tool history shows a successful local-only mount read.
///
/// Touches only the conversation records that qualify, and only by inserting a
/// single line: no reformatting, no Markdown twins, no `updated` bump, nothing
/// outside `conversations/`.
fn mark_private_conversations(vault_root: &std::path::Path, write: bool) -> anyhow::Result<()> {
    use alloy_server::tools::conversation_privacy as privacy;

    let dir = vault_root.join("conversations");
    let report = privacy::scan(&dir);

    println!("scanned            : {}", report.scanned);
    println!("already marked     : {}", report.already_marked);
    println!("refused only       : {} (left alone)", report.denied_only);
    println!("unreadable         : {}", report.unreadable.len());
    println!("would mark         : {}", report.candidates.len());
    println!();

    for c in &report.candidates {
        let name = c.path.file_name().unwrap_or_default().to_string_lossy();
        println!("  {:>3} read(s)  {}", c.reads, name);
        println!("              first: {}", c.example);
    }
    if report.candidates.is_empty() {
        println!("  (nothing to do)");
        return Ok(());
    }

    if !write {
        println!();
        println!("dry run: nothing written. Re-run with --write to apply.");
        return Ok(());
    }

    let mut applied = 0usize;
    let mut skipped = 0usize;
    for c in &report.candidates {
        let original = std::fs::read_to_string(&c.path)?;
        let Some(updated) = privacy::insert_marker(&original) else {
            // Shape we don't recognise, or already marked. Leave it untouched
            // rather than guess at someone's conversation.
            skipped += 1;
            tracing::warn!("skipped {}: unexpected file shape", c.path.display());
            continue;
        };
        let tmp = c.path.with_extension(format!("yaml.mark-{}", std::process::id()));
        std::fs::write(&tmp, &updated)?;
        std::fs::rename(&tmp, &c.path)?;
        applied += 1;
    }
    println!();
    println!("marked {applied} conversation(s); skipped {skipped}.");
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    alloy_server::logging::init("server", env!("CARGO_PKG_VERSION"));

    let args = Args::parse();

    tracing::info!("vault: {}", args.vault.display());
    let vault = Arc::new(Vault::new(args.vault.clone()).map_err(|e| {
        anyhow::anyhow!(
            "Failed to open vault {}: {}",
            args.vault.display(),
            e
        )
    })?);

    // One-shot maintenance: report (and optionally apply) markers for
    // conversations written before the marker existed, then exit without
    // serving. Runs before providers or watchers start — it only reads and
    // rewrites conversation records.
    if args.mark_private_conversations {
        return mark_private_conversations(vault.root(), args.write);
    }

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
    // Enforce the external-only invariant on private read-only dirs now that the
    // vault root is known (drops misconfigured entries with a warning).
    config.validate_private_dirs(vault.root());
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
    let tasks = Arc::new(SchedulerHandle::new());
    let runner_host = Arc::new(alloy_server::host::current_hostname());

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
        tasks: tasks.clone(),
        runner_host,
        self_base_url: Arc::new(std::sync::RwLock::new(Some(format!(
            "http://127.0.0.1:{}",
            args.port
        )))),
    };

    // Scheduled tasks run regardless of client presence.
    let _scheduler_task = spawn_scheduler(state.clone());

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
