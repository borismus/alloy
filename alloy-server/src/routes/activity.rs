//! `GET /api/activity` — is this server doing work right now?
//!
//! Exists for unattended updates: the desktop shell must not relaunch itself
//! while a turn or a scheduled task is running. Frontend state cannot answer
//! this, because work is owned by Rust and may have been started by another
//! device (a phone on the LAN) or by cron with no client attached at all.

use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/activity", get(handler))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// True when anything is in flight. Callers should treat an unreachable or
    /// unparseable response as busy rather than assuming idle.
    pub busy: bool,
    pub streaming_sessions: usize,
    pub running_tasks: usize,
}

async fn handler(State(state): State<AppState>) -> Json<Activity> {
    let streaming_sessions = state.sessions.streaming_count();
    let running_tasks = state.tasks.inflight.len();
    Json(Activity {
        busy: streaming_sessions > 0 || running_tasks > 0,
        streaming_sessions,
        running_tasks,
    })
}
