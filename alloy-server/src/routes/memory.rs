//! `/api/memory/proposal`: the user's accept or reject on a model's proposed
//! memory.md change. Models never write memory.md directly (see
//! `tools::files::propose_memory`); the proposed text is persisted on the tool
//! call, and accepting writes exactly that text, with the outgoing version
//! backed up.

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::vault_writer;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/memory/proposal", post(decide))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    conversation_id: String,
    message_id: String,
    tool_index: usize,
    accept: bool,
}

async fn decide(State(state): State<AppState>, Json(d): Json<Decision>) -> impl IntoResponse {
    let error = |status: StatusCode, message: String| (status, Json(json!({ "error": message })));
    let proposal = match vault_writer::memory_proposal(
        &state.vault,
        &d.conversation_id,
        &d.message_id,
        d.tool_index,
    )
    .await
    {
        Ok(p) => p,
        Err(e) => return error(StatusCode::NOT_FOUND, e.to_string()),
    };
    if let Some(decision) = proposal.decision {
        return error(StatusCode::CONFLICT, format!("This change was already {decision}."));
    }
    let decision = if d.accept {
        if let Err(e) = crate::tools::files::apply_memory(&state.tools, &proposal.content).await {
            return error(StatusCode::INTERNAL_SERVER_ERROR, e);
        }
        "accepted"
    } else {
        "rejected"
    };
    if let Err(e) = vault_writer::record_memory_decision(
        &state.vault,
        &d.conversation_id,
        &d.message_id,
        d.tool_index,
        decision,
    )
    .await
    {
        // memory.md is already written if accepted; say so rather than
        // implying nothing happened.
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("memory.md was {decision}, but recording it on the conversation failed: {e}"),
        );
    }
    (StatusCode::OK, Json(json!({ "decision": decision })))
}
