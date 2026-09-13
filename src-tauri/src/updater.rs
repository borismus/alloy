//! Unattended updates for an opted-in always-on machine.
//!
//! The decision logic lives in [`alloy_server::update_policy`]; this module is
//! the thin part that talks to Tauri and the filesystem. It replaces a loop that
//! ran in the webview, which macOS throttles whenever the window isn't in front
//! — precisely the machine this exists for — and whose decisions were written to
//! a console nobody can reach over SSH.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use alloy_server::embed::EmbeddedServer;
use alloy_server::update_policy::{
    plan, plan_after_check, plan_after_install, UpdateConditions, UpdateOutcome, UpdateStep,
    FIRST_CHECK, PREFERENCE_CHECK,
};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::UpdaterExt;

/// Machine-local preference. Deliberately not in the vault's `config.yaml`,
/// which is synced: an always-on box should update itself while the laptop you
/// are working on stays put. Owned by the shell rather than the webview so the
/// loop can read it before (and without) any window being open.
#[derive(Default)]
pub struct AutoUpdate {
    enabled: AtomicBool,
    /// Set once an update is written to disk but its restart deferred, so the
    /// bytes are fetched only once however long the machine stays busy.
    staged: AtomicBool,
    /// Identifies the live timer chain. Toggling the preference starts a fresh
    /// one; without this, each toggle would leave the previous chain running and
    /// they would accumulate for the life of the process.
    generation: AtomicU64,
}

impl AutoUpdate {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

fn preference_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("auto-update"))
}

fn read_preference<R: Runtime>(app: &AppHandle<R>) -> bool {
    preference_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == "true")
        .unwrap_or(false)
}

fn write_preference<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> std::io::Result<()> {
    let path = preference_path(app)
        .ok_or_else(|| std::io::Error::other("no app config directory"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, if enabled { "true" } else { "false" })
}

/// `configured` distinguishes "explicitly off" from "never set on this
/// machine", which the SPA needs to carry a pre-0.4.29 preference across
/// without overwriting a deliberate opt-out.
#[derive(serde::Serialize)]
pub struct AutoUpdateState {
    enabled: bool,
    configured: bool,
}

#[tauri::command]
pub fn get_auto_update(app: AppHandle, state: State<'_, Arc<AutoUpdate>>) -> AutoUpdateState {
    AutoUpdateState {
        enabled: state.is_enabled(),
        configured: preference_path(&app)
            .map(|path| path.exists())
            .unwrap_or(false),
    }
}

/// Persist the preference and, when switching on, check within seconds instead
/// of waiting out the hourly interval — turning a setting on should visibly do
/// something.
#[tauri::command]
pub fn set_auto_update(
    app: AppHandle,
    state: State<'_, Arc<AutoUpdate>>,
    enabled: bool,
) -> Result<(), String> {
    state.enabled.store(enabled, Ordering::Relaxed);
    write_preference(&app, enabled).map_err(|e| e.to_string())?;
    tracing::info!(enabled, "automatic updates preference changed");
    if enabled {
        restart_cycle(app, PREFERENCE_CHECK);
    }
    Ok(())
}

/// Start the loop. Runs for the process lifetime; each pass reads the
/// preference again, so opting out takes effect without a restart.
pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    let state = app.state::<Arc<AutoUpdate>>();
    let enabled = read_preference(&app);
    state.enabled.store(enabled, Ordering::Relaxed);
    tracing::info!(enabled, "automatic update loop started");
    restart_cycle(app, FIRST_CHECK);
}

/// Begin a new timer chain, abandoning any earlier one.
fn restart_cycle<R: Runtime>(app: AppHandle<R>, delay: std::time::Duration) {
    let generation = {
        let state = app.state::<Arc<AutoUpdate>>();
        state.generation.fetch_add(1, Ordering::Relaxed) + 1
    };
    spawn_cycle(app, delay, generation);
}

fn spawn_cycle<R: Runtime>(app: AppHandle<R>, delay: std::time::Duration, generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        // A newer chain started while this one slept (the preference was
        // toggled); let this one end rather than run in parallel.
        if app.state::<Arc<AutoUpdate>>().generation.load(Ordering::Relaxed) != generation {
            return;
        }
        let outcome = run_once(&app).await;
        // `Installed` means the process is on its way out; anything else waits.
        if outcome != UpdateOutcome::Installed {
            spawn_cycle(app, outcome.retry_after(), generation);
        }
    });
}

async fn run_once<R: Runtime>(app: &AppHandle<R>) -> UpdateOutcome {
    let state = app.state::<Arc<AutoUpdate>>();
    let server = app.state::<Arc<EmbeddedServer>>();
    let conditions = UpdateConditions {
        enabled: state.is_enabled(),
        idle: server.is_idle(),
        staged: state.staged.load(Ordering::Relaxed),
    };

    let outcome = match plan(conditions) {
        UpdateStep::Stop(outcome) => outcome,
        UpdateStep::Restart => restart(app),
        UpdateStep::CheckForUpdate => match check(app).await {
            Err(outcome) => outcome,
            Ok(None) => UpdateOutcome::UpToDate,
            Ok(Some(update)) => match plan_after_check(true) {
                UpdateStep::Install => install(app, update, &state).await,
                _ => UpdateOutcome::UpToDate,
            },
        },
        // `plan` never returns Install directly; an update must be found first.
        UpdateStep::Install => UpdateOutcome::Failed,
    };

    // An hourly "up to date" is 24 lines a day — nothing next to the turn
    // records, and it is the only way to answer "is it even checking?", which
    // was the first question asked of this feature. A machine that never opted
    // in says nothing, since that would be noise with no question behind it.
    match outcome {
        UpdateOutcome::Disabled => tracing::debug!(outcome = outcome.as_str(), "update check"),
        _ => tracing::info!(outcome = outcome.as_str(), "update check"),
    }
    outcome
}

async fn check<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<tauri_plugin_updater::Update>, UpdateOutcome> {
    let updater = app.updater().map_err(|error| {
        tracing::warn!(%error, "updater unavailable");
        UpdateOutcome::Failed
    })?;
    updater.check().await.map_err(|error| {
        // Network blips are expected on a laptop that sleeps; the backoff keeps
        // this from becoming a log flood.
        tracing::warn!(%error, "update check failed");
        UpdateOutcome::Failed
    })
}

async fn install<R: Runtime>(
    app: &AppHandle<R>,
    update: tauri_plugin_updater::Update,
    state: &Arc<AutoUpdate>,
) -> UpdateOutcome {
    let version = update.version.clone();
    tracing::info!(version = %version, "downloading update");
    if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
        tracing::warn!(version = %version, %error, "update install failed");
        return UpdateOutcome::Failed;
    }
    state.staged.store(true, Ordering::Relaxed);
    tracing::info!(version = %version, "update staged");

    // Re-check: a turn or task can have started while the bytes arrived.
    let server = app.state::<Arc<EmbeddedServer>>();
    match plan_after_install(server.is_idle()) {
        UpdateStep::Restart => restart(app),
        _ => UpdateOutcome::BusyAfterInstall,
    }
}

fn restart<R: Runtime>(app: &AppHandle<R>) -> UpdateOutcome {
    tracing::info!("restarting to apply update");
    app.restart();
}
