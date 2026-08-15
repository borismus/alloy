// Tauri shell entry point.
//
// Phase 2: embeds the alloy-server library — axum runs in this process,
// SPA inside the webview talks to it over HTTP. See
// /Users/boris/.claude/plans/rev-all-models-from-graceful-fox.md.

use std::{path::PathBuf, sync::Arc};

use alloy_server::embed::{EmbeddedServer, bootstrap_for_tauri};
use serde::Serialize;
use tauri::{Manager, State};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Returns the base URL the SPA should hit, or `null` if no vault has been
/// bound yet (first launch). SPA bootstrap calls this once on init.
#[tauri::command]
fn get_server_url(server: State<'_, Arc<EmbeddedServer>>) -> Option<String> {
    server.internal_url()
}

/// Sets/changes the vault path. Spins up a fresh embedded server bound to a
/// new random loopback port; returns the URL. SPA calls this after the
/// folder-picker flow (or when switching vaults).
#[tauri::command]
async fn set_vault_path(
    server: State<'_, Arc<EmbeddedServer>>,
    path: String,
) -> Result<String, String> {
    let vault = PathBuf::from(&path);
    match server.set_vault(vault).await {
        Ok(url) => {
            tracing::info!("vault bound: {path}");
            Ok(url)
        }
        Err(e) => {
            // The SPA surfaces this verbatim, so it must say WHY (missing
            // folder, permission denied, unparseable config) rather than just
            // failing and leaving the app to guess.
            tracing::error!("failed to bind vault {path}: {e}");
            Err(e.to_string())
        }
    }
}

#[derive(Serialize)]
struct ShareStatus {
    enabled: bool,
    port: u16,
    /// Public URL the user can hand to a phone, e.g.
    /// `http://your-mac.local:3001/`. None if sharing is off or hostname
    /// can't be determined.
    url: Option<String>,
    /// `false` until the user has picked a vault. The SPA disables the
    /// share toggle until this is true.
    vault_configured: bool,
}

#[tauri::command]
fn get_share_status(server: State<'_, Arc<EmbeddedServer>>) -> ShareStatus {
    let enabled = server.is_sharing();
    let port = server.share_port();
    let url = if enabled {
        Some(format!(
            "http://{}:{}/",
            hostname().unwrap_or_else(|| "localhost".into()),
            port
        ))
    } else {
        None
    };
    ShareStatus {
        enabled,
        port,
        url,
        vault_configured: server.has_vault(),
    }
}

/// Toggle public-network sharing. Persists the new value to config.yaml and
/// returns the resulting share status.
#[tauri::command]
async fn set_share_on_network(
    server: State<'_, Arc<EmbeddedServer>>,
    enabled: bool,
) -> Result<ShareStatus, String> {
    server
        .set_share(enabled)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ShareStatus {
        enabled: server.is_sharing(),
        port: server.share_port(),
        url: if server.is_sharing() {
            Some(format!(
                "http://{}:{}/",
                hostname().unwrap_or_else(|| "localhost".into()),
                server.share_port()
            ))
        } else {
            None
        },
        vault_configured: server.has_vault(),
    })
}

/// Best-effort machine hostname. Tries `gethostname` via libc on
/// Unix; falls back to None on errors. Used purely for displaying a
/// memorable URL — IP-based access also works.
fn hostname() -> Option<String> {
    #[cfg(unix)]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("hostname").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Install a tracing subscriber for the desktop build.
///
/// Without this the embedded server's `tracing::info!/warn!/error!` calls go
/// nowhere, so a failure to bind the vault produced no diagnostic anywhere —
/// not on stdout, not in a file, not in the UI. Defaults to `info`; override
/// with `ALLOY_LOG` (e.g. `ALLOY_LOG=debug`). Launch the binary directly
/// (`/Applications/Alloy.app/Contents/MacOS/Alloy`) to read it.
fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("ALLOY_LOG")
        .or_else(|_| tracing_subscriber::EnvFilter::try_new("info"))
        .unwrap_or_default();
    // `try_init` so a second call (tests, repeated init) can't panic.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

pub fn run() {
    init_logging();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Bootstrap with no initial vault — SPA will call set_vault_path
            // once the user has picked one (or restored from localStorage).
            // Future: read a Tauri-side persisted vault path here so the
            // server is ready before the window appears on subsequent
            // launches.
            let server = tauri::async_runtime::block_on(bootstrap_for_tauri(None))
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(server);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_server_url,
            set_vault_path,
            get_share_status,
            set_share_on_network,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
