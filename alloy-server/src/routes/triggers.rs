//! `POST /api/triggers/{id}/run` — fire a trigger synchronously.
//!
//! Used by the SPA's "Run Now" button and immediately after creating a new
//! trigger to force the baseline run with zero wait. The handler awaits
//! `executor::run` to completion (could be tens of seconds for tool-heavy
//! triggers) and returns the `TriggerRunOutcome` as JSON.

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};

use crate::triggers::model::TriggerRunOutcome;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/triggers/{id}/run", post(run_handler))
}

async fn run_handler(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match crate::triggers::scheduler::run_by_id(&state, &state.triggers.inflight, &id).await {
        Ok(outcome) => Json(outcome).into_response(),
        Err(e) => {
            tracing::warn!("trigger run {} failed: {}", id, e);
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(TriggerRunOutcome {
                    result: crate::triggers::model::TriggerVerdict::Error,
                    response: String::new(),
                    error: Some(e.to_string()),
                    usage: None,
                }),
            )
                .into_response()
        }
    }
}
