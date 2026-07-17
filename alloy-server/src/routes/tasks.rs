//! Manual scheduled-task execution routes.

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};

use crate::tasks::model::{TaskRunOutcome, TaskVerdict};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/tasks/{id}/run", post(run_handler))
}

async fn run_handler(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match crate::tasks::scheduler::run_by_id(&state, &state.tasks.inflight, &id).await {
        Ok(outcome) => Json(outcome).into_response(),
        Err(error) => {
            tracing::warn!("task run {} failed: {}", id, error);
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(TaskRunOutcome {
                    result: TaskVerdict::Error,
                    response: String::new(),
                    error: Some(error.to_string()),
                    usage: None,
                }),
            )
                .into_response()
        }
    }
}
