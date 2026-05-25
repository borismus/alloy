//! `/api/watch` — WebSocket file watcher.
//!
//! Watches the vault root with `notify` and broadcasts events to all
//! connected WebSocket clients. Event shape mirrors today's Node server
//! (which uses chokidar):
//!
//! ```json
//! { "type": { "create": { "kind": "file" } }, "paths": ["relative/path"] }
//! ```
//!
//! Dotfile events are filtered out to match chokidar's `ignored: /\../` config.

use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use notify::{Event, EventKind, RecursiveMode, Watcher, event::CreateKind};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::{AppState, vault::Vault};

/// Channel for broadcasting watcher events to all connected WS clients.
/// Held alive for the lifetime of the process; receivers are created per
/// WS connection.
#[derive(Clone)]
pub struct WatcherChannel(pub broadcast::Sender<Value>);

pub fn router() -> Router<AppState> {
    Router::new().route("/api/watch", get(ws_handler))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let rx = state.watcher.0.subscribe();
    ws.on_upgrade(move |socket| client_loop(socket, rx))
}

async fn client_loop(socket: WebSocket, mut rx: broadcast::Receiver<Value>) {
    let (mut sender, mut receiver) = socket.split();
    tracing::info!("[watch] client connected");

    loop {
        tokio::select! {
            // Server → client: forward broadcast events.
            event = rx.recv() => {
                match event {
                    Ok(event) => {
                        let text = match serde_json::to_string(&event) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        if sender.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[watch] client lagged {} events", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // Client → server: we don't expect messages, but draining keeps
            // the socket healthy and handles client-side close cleanly.
            msg = receiver.next() => {
                match msg {
                    None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => continue,
                }
            }
        }
    }

    tracing::info!("[watch] client disconnected");
}

/// Start the filesystem watcher and return the broadcast channel. The
/// watcher runs in a background task for the lifetime of the process.
pub fn spawn_watcher(vault: Arc<Vault>) -> anyhow::Result<WatcherChannel> {
    let (tx, _) = broadcast::channel::<Value>(256);
    let tx_clone = tx.clone();
    let vault_for_watcher = vault.clone();

    // notify's recommended watcher; we don't need debouncing because chokidar
    // didn't either (it was configured at default sensitivity).
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("[watch] notify error: {}", e);
                return;
            }
        };

        for path in &event.paths {
            // Ignore dotfile events (matches chokidar's `/\../` ignored regex).
            if is_dotfile(path) {
                continue;
            }
            let relative = vault_for_watcher.relativize(path);
            let payload = json!({
                "type": event_to_wire(&event.kind, path),
                "paths": [relative.to_string_lossy()],
            });
            // Ignore send errors: just means no subscribers yet.
            let _ = tx_clone.send(payload);
        }
    })?;

    watcher.watch(vault.root(), RecursiveMode::Recursive)?;

    // Move the watcher into a long-lived task so its Drop doesn't fire.
    tokio::spawn(async move {
        let _watcher = watcher; // keep alive
        // Park forever. The watcher emits events via its callback.
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });

    Ok(WatcherChannel(tx))
}

fn is_dotfile(path: &std::path::Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| s.starts_with('.') && s != "." && s != "..")
            .unwrap_or(false)
    })
}

/// Map a notify Event to the wire format the SPA expects.
///
/// SPA discriminates between `file` and `folder` kinds for create/remove; for
/// `modify` it only uses `{ kind: 'data' }`. We do a best-effort `is_dir()`
/// check for create/remove. If the file no longer exists by the time we
/// check (race on remove), assume "file".
fn event_to_wire(kind: &EventKind, path: &PathBuf) -> Value {
    match kind {
        EventKind::Create(create_kind) => {
            let is_folder = match create_kind {
                CreateKind::Folder => true,
                CreateKind::File => false,
                _ => path.is_dir(),
            };
            json!({ "create": { "kind": if is_folder { "folder" } else { "file" } } })
        }
        EventKind::Modify(_) => json!({ "modify": { "kind": "data" } }),
        EventKind::Remove(remove_kind) => {
            use notify::event::RemoveKind;
            let is_folder = matches!(remove_kind, RemoveKind::Folder);
            json!({ "remove": { "kind": if is_folder { "folder" } else { "file" } } })
        }
        _ => json!({ "other": {} }),
    }
}
