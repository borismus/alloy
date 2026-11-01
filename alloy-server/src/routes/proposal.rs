//! `/api/proposal`: the user's accept or reject on a model's proposed change to
//! memory.md or a skill. Models never write those directly (see
//! `tools::files::propose_memory` and `propose_skill`); the proposed text is
//! persisted on the tool call, and accepting writes exactly that text.

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::tools::files;
use crate::vault_writer;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/proposal", post(decide))
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
    let proposal = match vault_writer::file_proposal(
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
        let applied = if proposal.path == "memory.md" {
            files::apply_memory(&state.tools, &proposal.content).await
        } else {
            files::apply_skill(&state.tools, &proposal.path, &proposal.content).await
        };
        if let Err(e) = applied {
            return error(StatusCode::INTERNAL_SERVER_ERROR, e);
        }
        "accepted"
    } else {
        "rejected"
    };
    if let Err(e) = vault_writer::record_proposal_decision(
        &state.vault,
        &d.conversation_id,
        &d.message_id,
        d.tool_index,
        decision,
    )
    .await
    {
        // The file is already written if accepted; say so rather than
        // implying nothing happened.
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "{} was {decision}, but recording it on the conversation failed: {e}",
                proposal.path
            ),
        );
    }
    (StatusCode::OK, Json(json!({ "decision": decision })))
}
