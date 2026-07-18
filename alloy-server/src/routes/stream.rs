//! `/api/stream/*` endpoints.
//!
//! Wire format mirrors [server/index.ts](server/index.ts) /api/stream/start
//! and the SSE event names consumed by
//! [src/services/server-streaming.ts](src/services/server-streaming.ts):
//! `thinking_state`, `thinking`, `thinking_done`, `replay`, `chunk`, `title`,
//! `complete`, `error`.

use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::{Stream, StreamExt};
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;

use crate::{
    streaming::{self, SessionEvent, SessionStatus, StartParams},
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/stream/start", post(start))
        .route("/api/stream/events/{id}", get(events))
        .route("/api/stream/stop/{id}", post(stop))
        .route("/api/stream/active", get(active))
}

async fn start(State(state): State<AppState>, Json(params): Json<StartParams>) -> Response {
    let session_id = params.session_id.clone();
    let self_base_url = state.self_base_url.read().ok().and_then(|u| u.clone());
    let session = streaming::start_session(
        &state.sessions,
        state.providers.clone(),
        state.vault.clone(),
        state.tools.clone(),
        state.model_cache.clone(),
        state.config.compaction,
        self_base_url,
        params,
    );
    match session {
        Ok(_) => Json(json!({ "sessionId": session_id, "status": "streaming" })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn events(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(session) = state.sessions.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Session not found" })),
        )
            .into_response();
    };

    // Snapshot replay state and attach the live receiver under the same lock
    // used by the delta pump. This prevents a token from landing in the gap
    // between the snapshot and subscription.
    let (
        initial_content,
        initial_thinking,
        thinking_elapsed_ms,
        thinking_duration_ms,
        status,
        final_result,
        final_title,
        error_message,
        tool_history,
        live,
    ) = {
        let inner = session.inner.lock().unwrap();
        let status = inner.status.clone();
        let thinking_elapsed_ms = inner.thinking_duration_ms.unwrap_or_else(|| {
            (chrono::Utc::now().timestamp_millis() - inner.started_at_ms).max(0) as u64
        });
        let live = if status == SessionStatus::Streaming {
            Some(session.subscribe())
        } else {
            None
        };
        (
            inner.full_content.clone(),
            inner.full_thinking.clone(),
            thinking_elapsed_ms,
            inner.thinking_duration_ms,
            status,
            inner.final_result.clone(),
            inner.final_title.clone(),
            inner.error_message.clone(),
            inner.tool_history.clone(),
            live,
        )
    };

    // Build an SSE stream by chaining: initial events → live broadcast (if any).
    let stream = async_stream::stream! {
        // Always establish the timer, even for providers that don't expose
        // reasoning. `content` is ephemeral and bounded in SessionInner.
        yield Ok::<_, Infallible>(
            Event::default().event("thinking_state").data(json!({
                "content": initial_thinking,
                "elapsedMs": thinking_elapsed_ms,
                "durationMs": thinking_duration_ms,
            }).to_string()),
        );
        if !initial_content.is_empty() {
            yield Ok::<_, Infallible>(
                Event::default()
                    .event("replay")
                    .data(json!({ "content": initial_content }).to_string()),
            );
        }
        // Replay tool history so late subscribers see the same pills the
        // live subscriber saw, in order.
        for entry in &tool_history {
            use crate::streaming::ToolHistoryEntry;
            match entry {
                ToolHistoryEntry::Use { id, name, input } => {
                    yield Ok(Event::default().event("tool_use").data(json!({
                        "id": id, "name": name, "input": input,
                    }).to_string()));
                }
                ToolHistoryEntry::Result { tool_use_id, content, is_error } => {
                    yield Ok(Event::default().event("tool_result").data(json!({
                        "tool_use_id": tool_use_id,
                        "content": content,
                        "is_error": is_error,
                    }).to_string()));
                }
            }
        }
        if let Some(title) = &final_title {
            yield Ok(
                Event::default()
                    .event("title")
                    .data(json!({ "title": title }).to_string()),
            );
        }

        match status {
            SessionStatus::Complete => {
                if let Some(result) = final_result {
                    yield Ok(
                        Event::default().event("complete").data(json!({
                            "content": result.content,
                            "usage": result.usage,
                            "stopReason": result.stop_reason,
                        }).to_string()),
                    );
                }
                return;
            }
            SessionStatus::Error => {
                let msg = error_message.unwrap_or_else(|| "Unknown error".into());
                yield Ok(
                    Event::default()
                        .event("error")
                        .data(json!({ "message": msg }).to_string()),
                );
                return;
            }
            SessionStatus::Streaming => {}
        }

        if let Some(rx) = live {
            let mut stream = BroadcastStream::new(rx);
            while let Some(event) = stream.next().await {
                let session_event = match event {
                    Ok(e) => e,
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                        tracing::warn!("SSE subscriber lagged {} events", n);
                        continue;
                    }
                };
                match session_event {
                    SessionEvent::Chunk(text) => {
                        yield Ok(Event::default().event("chunk").data(
                            json!({ "text": text }).to_string()
                        ));
                    }
                    SessionEvent::Thinking(text) => {
                        yield Ok(Event::default().event("thinking").data(
                            json!({ "text": text }).to_string()
                        ));
                    }
                    SessionEvent::ThinkingDone(duration_ms) => {
                        yield Ok(Event::default().event("thinking_done").data(
                            json!({ "durationMs": duration_ms }).to_string()
                        ));
                    }
                    SessionEvent::Title(title) => {
                        yield Ok(Event::default().event("title").data(
                            json!({ "title": title }).to_string()
                        ));
                    }
                    SessionEvent::ToolUse(call) => {
                        yield Ok(Event::default().event("tool_use").data(json!({
                            "id": call.id,
                            "name": call.name,
                            "input": call.input,
                        }).to_string()));
                    }
                    SessionEvent::ToolResult(result) => {
                        yield Ok(Event::default().event("tool_result").data(json!({
                            "tool_use_id": result.tool_use_id,
                            "content": result.content,
                            "is_error": result.is_error.unwrap_or(false),
                        }).to_string()));
                    }
                    SessionEvent::Complete { content, usage, stop_reason } => {
                        yield Ok(Event::default().event("complete").data(json!({
                            "content": content,
                            "usage": usage,
                            "stopReason": stop_reason,
                        }).to_string()));
                        return;
                    }
                    SessionEvent::Error(msg) => {
                        yield Ok(Event::default().event("error").data(
                            json!({ "message": msg }).to_string()
                        ));
                        return;
                    }
                }
            }
        }
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(session) = streaming::stop_session(&state.sessions, &id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Session not found" })),
        )
            .into_response();
    };
    let partial = session.inner.lock().unwrap().full_content.clone();
    Json(json!({ "status": "stopped", "partialContent": partial })).into_response()
}

async fn active(State(state): State<AppState>) -> Response {
    Json(state.sessions.active()).into_response()
}

// Make the async_stream macro available at crate root.
#[allow(dead_code)]
fn _stream_check() -> impl Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        yield Ok::<_, Infallible>(Event::default().data("ping"));
    }
}
