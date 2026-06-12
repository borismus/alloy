//! Streaming session manager.
//!
//! Mirrors the design in [server/streaming.ts](server/streaming.ts):
//! - Each `start_session` spawns a background task that runs the model stream.
//! - Chunks fan out to SSE subscribers via a tokio broadcast channel.
//! - Late subscribers get a `replay` event with the accumulated content first.
//! - Completed sessions stick around for `SESSION_TTL` so reload-after-finish
//!   reconnects can still pull the final result.
//!
//! In M4+, the actual model interaction goes through `tool_loop::execute_with_tools`
//! so the loop iterates on `tool_use` stop reasons and dispatches builtin tools.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, watch};

use crate::compaction::{self, CompactionSettings, NewCompacted};
use crate::routes::models::ModelCache;
use crate::tool_loop::{LoopRequest, ToolEventSink, execute_with_tools};
use crate::tools::{ToolContext, ToolRegistry};
use crate::types::{ToolCall, ToolResult, builtin_tools};
use crate::{
    providers::{ProviderRegistry, StreamResult, Usage, WireMessage},
    vault::Vault,
    vault_writer::{self, AssistantWrite, PersistedToolUse},
};

const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const BROADCAST_CAP: usize = 256;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Streaming,
    Complete,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub status: SessionStatus,
}

pub struct SessionInner {
    pub conversation_id: String,
    pub assistant_message_id: String,
    pub status: SessionStatus,
    pub full_content: String,
    pub final_result: Option<StreamResult>,
    pub final_title: Option<String>,
    pub error_message: Option<String>,
    /// Tool calls/results observed during this session — replayed to late
    /// subscribers along with the accumulated text content.
    pub tool_history: Vec<ToolHistoryEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ToolHistoryEntry {
    Use {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    Result {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

/// Broadcast events fanned out to SSE subscribers.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    Chunk(String),
    Title(String),
    ToolUse(ToolCall),
    ToolResult(ToolResult),
    Complete {
        content: String,
        usage: Option<Usage>,
        stop_reason: String,
    },
    Error(String),
}

pub struct Session {
    pub inner: Mutex<SessionInner>,
    pub tx: broadcast::Sender<SessionEvent>,
    pub cancel: watch::Sender<bool>,
}

impl Session {
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.tx.subscribe()
    }
}

#[derive(Clone, Default)]
pub struct SessionRegistry {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn active(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, s)| {
                let inner = s.inner.lock().unwrap();
                SessionInfo {
                    session_id: id.clone(),
                    conversation_id: inner.conversation_id.clone(),
                    status: inner.status.clone(),
                }
            })
            .collect()
    }

    fn insert(&self, id: String, session: Arc<Session>) {
        self.sessions.lock().unwrap().insert(id, session);
    }

    fn schedule_cleanup(&self, id: String) {
        let registry = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SESSION_TTL).await;
            let mut map = registry.sessions.lock().unwrap();
            if let Some(s) = map.get(&id) {
                let status = s.inner.lock().unwrap().status.clone();
                if status != SessionStatus::Streaming {
                    map.remove(&id);
                    tracing::info!("session {} cleaned up", id);
                }
            }
        });
    }
}

#[derive(Debug, Deserialize)]
pub struct StartParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId", default)]
    pub assistant_message_id: Option<String>,
    pub model: String,
    pub messages: Vec<WireMessage>,
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: Option<String>,
    #[serde(rename = "isFirstMessage", default)]
    pub is_first_message: bool,
    #[serde(rename = "userMessageContent", default)]
    pub user_message_content: String,
    /// Skip appending the assistant message to a conversation YAML.
    /// Used by triggers (whose results live in `triggers/*.yaml`, not
    /// `conversations/*.yaml`) and other programmatic callers that
    /// don't have a conversation file at all.
    #[serde(rename = "skipPersist", default)]
    pub skip_persist: bool,
}

/// Start a new streaming session. Returns the registered session immediately;
/// the stream runs in the background.
pub fn start_session(
    registry: &SessionRegistry,
    providers: ProviderRegistry,
    vault: Arc<Vault>,
    tools: Arc<ToolRegistry>,
    model_cache: Arc<ModelCache>,
    compaction: CompactionSettings,
    params: StartParams,
) -> anyhow::Result<Arc<Session>> {
    // Idempotency: if the session id already exists, return it.
    if let Some(existing) = registry.get(&params.session_id) {
        return Ok(existing);
    }

    let (tx, _) = broadcast::channel::<SessionEvent>(BROADCAST_CAP);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let assistant_message_id = params
        .assistant_message_id
        .clone()
        .unwrap_or_else(|| format!("msg-{}", chrono::Utc::now().timestamp_millis()));

    let session = Arc::new(Session {
        inner: Mutex::new(SessionInner {
            conversation_id: params.conversation_id.clone(),
            assistant_message_id: assistant_message_id.clone(),
            status: SessionStatus::Streaming,
            full_content: String::new(),
            final_result: None,
            final_title: None,
            error_message: None,
            tool_history: Vec::new(),
        }),
        tx: tx.clone(),
        cancel: cancel_tx,
    });
    registry.insert(params.session_id.clone(), session.clone());

    // Spawn the background streamer.
    let session_for_task = session.clone();
    let registry_clone = registry.clone();
    let session_id = params.session_id.clone();
    tokio::spawn(async move {
        run_stream(
            session_for_task,
            providers,
            vault,
            tools,
            model_cache,
            compaction,
            params,
            cancel_rx,
        )
        .await;
        registry_clone.schedule_cleanup(session_id);
    });

    Ok(session)
}

#[allow(clippy::too_many_arguments)]
async fn run_stream(
    session: Arc<Session>,
    providers: ProviderRegistry,
    vault: Arc<Vault>,
    tools: Arc<ToolRegistry>,
    model_cache: Arc<ModelCache>,
    compaction: CompactionSettings,
    params: StartParams,
    cancel: watch::Receiver<bool>,
) {
    let (provider, upstream_model) = match providers.resolve(&params.model) {
        Ok(r) => r,
        Err(msg) => {
            mark_error(&session, msg);
            return;
        }
    };
    let upstream_model = upstream_model.to_string();

    let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel::<String>();

    // Pump per-token chunks from the provider into the SSE broadcast channel.
    let session_pump = session.clone();
    let pump = tokio::spawn(async move {
        while let Some(text) = chunk_rx.recv().await {
            {
                let mut inner = session_pump.inner.lock().unwrap();
                inner.full_content.push_str(&text);
            }
            let _ = session_pump.tx.send(SessionEvent::Chunk(text));
        }
    });

    // Sink that forwards tool events through the broadcast channel and also
    // appends them to the session's tool_history for late-subscriber replay.
    let sink: Arc<dyn ToolEventSink> = Arc::new(SessionToolSink {
        session: session.clone(),
    });

    // Compaction: build the send view (folding older turns into a summary when
    // over budget). Returns the messages to send plus an optional summary to
    // persist at completion. Never compact when there's no conversation file to
    // persist into (skip_persist) — but the in-memory send view is still built.
    let cw = model_cache.context_window_for(&params.model);
    let prepared = compaction::prepare(
        &params.messages,
        params.system_prompt.as_deref(),
        Some(vault.as_ref()),
        provider.as_ref(),
        &upstream_model,
        cw,
        &compaction,
    )
    .await;
    let messages = prepared.send;
    // Only persist a freshly-generated compacted message when we own a
    // conversation file (triggers/riff run with skip_persist and ephemeral
    // histories).
    let new_compacted: Option<NewCompacted> = if params.skip_persist {
        None
    } else {
        prepared.new_compacted
    };

    let loop_req = LoopRequest {
        provider: provider.clone(),
        model: upstream_model.clone(),
        messages,
        tools: if provider.supports_tools(&upstream_model) {
            builtin_tools()
        } else {
            Vec::new()
        },
        chunk_tx,
        cancel: cancel.clone(),
        tool_ctx: ToolContext {
            message_id: Some(session.inner.lock().unwrap().assistant_message_id.clone()),
            conversation_id: Some(format!("conversations/{}", params.conversation_id)),
            inside_subagent: false,
        },
    };

    let result = execute_with_tools(loop_req, tools, sink).await;
    let _ = pump.await;

    match result {
        Ok(mut stream_result) => {
            // Compute USD cost from cached pricing (sourced from OpenRouter's
            // /models endpoint via ModelCache). If the model isn't in the
            // cache yet — first conversation before /api/models ran — cost
            // stays unset.
            if let Some(usage) = stream_result.usage.as_mut() {
                if let Some((in_per_m, out_per_m)) = model_cache.pricing_for(&params.model) {
                    let cost = (usage.input_tokens as f64 * in_per_m
                        + usage.output_tokens as f64 * out_per_m)
                        / 1_000_000.0;
                    usage.cost = Some(cost);
                }
            }

            if !params.skip_persist {
                let (assistant_message_id, tool_use) = {
                    let inner = session.inner.lock().unwrap();
                    (inner.assistant_message_id.clone(), collect_tool_uses(&inner.tool_history))
                };
                let write = AssistantWrite {
                    conversation_id: params.conversation_id.clone(),
                    assistant_message_id,
                    content: stream_result.content.clone(),
                    usage: stream_result.usage.clone(),
                    compacted: new_compacted,
                    tool_use,
                };
                if let Err(e) = vault_writer::append_assistant_message(&vault, write).await {
                    tracing::warn!("failed to append assistant message: {}", e);
                }
            }

            // Title generation for first messages — skip when not persisting
            // (programmatic callers don't have a conversation file to rename).
            let mut maybe_title = None;
            if !params.skip_persist
                && params.is_first_message
                && !stream_result.content.trim().is_empty()
            {
                let title_model = pick_title_model(&params.model);
                let title = provider
                    .generate_title(
                        &params.user_message_content,
                        &stream_result.content,
                        &title_model,
                    )
                    .await;
                if !title.is_empty() {
                    if let Err(e) =
                        vault_writer::update_title(&vault, &params.conversation_id, &title).await
                    {
                        tracing::warn!("failed to update title: {}", e);
                    }
                    let _ = session.tx.send(SessionEvent::Title(title.clone()));
                    maybe_title = Some(title);
                }
            }

            {
                let mut inner = session.inner.lock().unwrap();
                inner.status = SessionStatus::Complete;
                inner.final_result = Some(stream_result.clone());
                inner.final_title = maybe_title;
            }
            let _ = session.tx.send(SessionEvent::Complete {
                content: stream_result.content,
                usage: stream_result.usage,
                stop_reason: stream_result.stop_reason,
            });
        }
        Err(e) => {
            let msg = e.to_string();

            // Persist whatever the turn produced so it isn't lost — only if
            // we'd normally persist this session at all. The model often emits
            // tool calls (e.g. web_search) with no prose yet; if the turn then
            // ends early (the user hits escape, or the follow-up provider call
            // errors), gating on text alone would discard the whole turn —
            // including the tool calls the user already watched run — and leave
            // a dangling user message. Persist when there's partial text OR any
            // tool history.
            //
            // Do this BEFORE signalling the error: the client reacts to the
            // error event by reloading this file, so the turn must already be
            // written or the client would reload a stale file (and could
            // overwrite this turn).
            if !params.skip_persist {
                let (partial, assistant_message_id, tool_use) = {
                    let inner = session.inner.lock().unwrap();
                    (
                        inner.full_content.clone(),
                        inner.assistant_message_id.clone(),
                        collect_tool_uses(&inner.tool_history),
                    )
                };
                if !partial.trim().is_empty() || !tool_use.is_empty() {
                    let write = AssistantWrite {
                        conversation_id: params.conversation_id.clone(),
                        assistant_message_id,
                        content: partial,
                        usage: None,
                        compacted: None,
                        tool_use,
                    };
                    if let Err(e) = vault_writer::append_assistant_message(&vault, write).await {
                        tracing::warn!("failed to persist partial content: {}", e);
                    }
                }
            }

            mark_error(&session, msg);
        }
    }
}

fn mark_error(session: &Session, msg: String) {
    tracing::error!("session error: {}", msg);
    {
        let mut inner = session.inner.lock().unwrap();
        inner.status = SessionStatus::Error;
        inner.error_message = Some(msg.clone());
    }
    let _ = session.tx.send(SessionEvent::Error(msg));
}

/// Fold a session's `tool_history` (interleaved Use/Result entries) into the
/// flat `PersistedToolUse` shape the conversation YAML stores. Each `Use` is
/// paired with its `Result` by id; the result string is truncated to 500 chars
/// to match the live-display truncation in
/// [src/services/server-streaming.ts](src/services/server-streaming.ts).
fn collect_tool_uses(history: &[ToolHistoryEntry]) -> Vec<PersistedToolUse> {
    let mut results: HashMap<&str, (&str, bool)> = HashMap::new();
    for entry in history {
        if let ToolHistoryEntry::Result { tool_use_id, content, is_error } = entry {
            results.insert(tool_use_id.as_str(), (content.as_str(), *is_error));
        }
    }
    history
        .iter()
        .filter_map(|entry| match entry {
            ToolHistoryEntry::Use { id, name, input } => {
                let (result, is_error) = match results.get(id.as_str()) {
                    Some((content, err)) => (
                        Some(content.chars().take(500).collect::<String>()),
                        err.then_some(true),
                    ),
                    None => (None, None),
                };
                Some(PersistedToolUse {
                    tool_type: name.clone(),
                    input: Some(input.clone()),
                    result,
                    is_error,
                })
            }
            ToolHistoryEntry::Result { .. } => None,
        })
        .collect()
}

struct SessionToolSink {
    session: Arc<Session>,
}

impl ToolEventSink for SessionToolSink {
    fn on_tool_use(&self, call: &ToolCall) {
        {
            let mut inner = self.session.inner.lock().unwrap();
            inner.tool_history.push(ToolHistoryEntry::Use {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            });
        }
        let _ = self.session.tx.send(SessionEvent::ToolUse(call.clone()));
    }

    fn on_tool_result(&self, result: &ToolResult) {
        {
            let mut inner = self.session.inner.lock().unwrap();
            inner.tool_history.push(ToolHistoryEntry::Result {
                tool_use_id: result.tool_use_id.clone(),
                content: result.content.clone(),
                is_error: result.is_error.unwrap_or(false),
            });
        }
        let _ = self
            .session
            .tx
            .send(SessionEvent::ToolResult(result.clone()));
    }
}

/// Final outcome of a streaming session — used by callers (like the
/// trigger executor) that need to await completion synchronously rather
/// than fan events out over SSE.
#[derive(Debug, Clone)]
pub struct SessionOutcome {
    pub content: String,
    pub usage: Option<Usage>,
    pub stop_reason: String,
}

/// Run a streaming session and await its terminal event. Used by
/// programmatic callers (triggers, internal tasks) that want the final
/// result rather than an SSE stream.
pub async fn run_to_completion(
    registry: &SessionRegistry,
    providers: ProviderRegistry,
    vault: Arc<Vault>,
    tools: Arc<ToolRegistry>,
    model_cache: Arc<ModelCache>,
    compaction: CompactionSettings,
    params: StartParams,
) -> anyhow::Result<SessionOutcome> {
    let session = start_session(registry, providers, vault, tools, model_cache, compaction, params)?;
    let mut rx = session.subscribe();

    // Cover the race where the background task already finished between
    // `start_session` returning and us subscribing.
    {
        let inner = session.inner.lock().unwrap();
        match inner.status {
            SessionStatus::Complete => {
                if let Some(r) = inner.final_result.clone() {
                    return Ok(SessionOutcome {
                        content: r.content,
                        usage: r.usage,
                        stop_reason: r.stop_reason,
                    });
                }
            }
            SessionStatus::Error => {
                anyhow::bail!(
                    "session error: {}",
                    inner.error_message.clone().unwrap_or_default()
                );
            }
            SessionStatus::Streaming => {}
        }
    }

    loop {
        match rx.recv().await {
            Ok(SessionEvent::Complete {
                content,
                usage,
                stop_reason,
            }) => {
                return Ok(SessionOutcome {
                    content,
                    usage,
                    stop_reason,
                });
            }
            Ok(SessionEvent::Error(msg)) => anyhow::bail!("session error: {}", msg),
            // Ignore chunks, tool events, title.
            Ok(_) => continue,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => {
                // No more events incoming — fall back to whatever the
                // session state holds.
                let inner = session.inner.lock().unwrap();
                if let Some(r) = inner.final_result.clone() {
                    return Ok(SessionOutcome {
                        content: r.content,
                        usage: r.usage,
                        stop_reason: r.stop_reason,
                    });
                }
                if let Some(err) = inner.error_message.clone() {
                    anyhow::bail!("session error: {}", err);
                }
                anyhow::bail!("session channel closed without a final event");
            }
        }
    }
}

/// Stop a session. Returns the session if it existed so the caller can
/// report partial content.
pub fn stop_session(registry: &SessionRegistry, id: &str) -> Option<Arc<Session>> {
    let session = registry.get(id)?;
    let was_streaming = session.inner.lock().unwrap().status == SessionStatus::Streaming;
    if was_streaming {
        let _ = session.cancel.send(true);
    }
    Some(session)
}

/// Pick a model for title generation. Phase-1 cheap default: Haiku via the
/// configured provider.
fn pick_title_model(conversation_model: &str) -> String {
    if let Some((prefix, _)) = conversation_model.split_once('/') {
        match prefix {
            "openrouter" => return "anthropic/claude-haiku-4-5".to_string(),
            "ollama" => return conversation_model.to_string(),
            _ => {}
        }
    }
    "anthropic/claude-haiku-4-5".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn use_entry(id: &str, name: &str) -> ToolHistoryEntry {
        ToolHistoryEntry::Use {
            id: id.into(),
            name: name.into(),
            input: json!({ "q": id }),
        }
    }

    #[test]
    fn collect_pairs_results_and_sets_error_only_when_true() {
        let history = vec![
            use_entry("t1", "web_search"),
            ToolHistoryEntry::Result {
                tool_use_id: "t1".into(),
                content: "ok".into(),
                is_error: false,
            },
            use_entry("t2", "http_get"),
            ToolHistoryEntry::Result {
                tool_use_id: "t2".into(),
                content: "boom".into(),
                is_error: true,
            },
            // A Use with no matching Result (e.g. cancelled before completion).
            use_entry("t3", "read_file"),
        ];
        let out = collect_tool_uses(&history);
        assert_eq!(out.len(), 3, "one PersistedToolUse per Use entry");

        assert_eq!(out[0].tool_type, "web_search");
        assert_eq!(out[0].result.as_deref(), Some("ok"));
        assert_eq!(out[0].is_error, None, "success omits isError");

        assert_eq!(out[1].result.as_deref(), Some("boom"));
        assert_eq!(out[1].is_error, Some(true), "error sets isError=true");

        assert_eq!(out[2].result, None, "unpaired use has no result");
        assert_eq!(out[2].is_error, None);
    }

    #[test]
    fn collect_truncates_result_to_500_chars() {
        let history = vec![
            use_entry("t1", "http_get"),
            ToolHistoryEntry::Result {
                tool_use_id: "t1".into(),
                content: "x".repeat(1200),
                is_error: false,
            },
        ];
        let out = collect_tool_uses(&history);
        assert_eq!(out[0].result.as_deref().unwrap().chars().count(), 500);
    }

    #[test]
    fn collect_empty_history_is_empty() {
        assert!(collect_tool_uses(&[]).is_empty());
    }

    // The persisted YAML keys must match the frontend `ToolUse` interface
    // (type/input/result/isError) or the pills won't re-render on reload.
    #[test]
    fn persisted_shape_uses_frontend_keys() {
        let history = vec![
            use_entry("t1", "http_get"),
            ToolHistoryEntry::Result {
                tool_use_id: "t1".into(),
                content: "boom".into(),
                is_error: true,
            },
        ];
        let yaml = serde_yaml::to_string(&collect_tool_uses(&history)).unwrap();
        assert!(yaml.contains("type: http_get"), "got:\n{yaml}");
        assert!(yaml.contains("isError: true"), "got:\n{yaml}");
        assert!(yaml.contains("result: boom"), "got:\n{yaml}");
        assert!(yaml.contains("input:"), "got:\n{yaml}");
        // Success case must omit isError entirely (not isError: false).
        let ok = vec![
            use_entry("t2", "web_search"),
            ToolHistoryEntry::Result {
                tool_use_id: "t2".into(),
                content: "fine".into(),
                is_error: false,
            },
        ];
        let yaml_ok = serde_yaml::to_string(&collect_tool_uses(&ok)).unwrap();
        assert!(!yaml_ok.contains("isError"), "success should omit isError:\n{yaml_ok}");
    }
}
