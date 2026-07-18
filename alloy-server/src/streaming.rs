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
use crate::tool_loop::{execute_with_tools, LoopRequest};
use crate::tools::{ToolContext, ToolRegistry};
use crate::types::{builtin_tools, ToolCall, ToolEventSink, ToolResult};
use crate::{
    providers::{
        McpBridge, ProviderRegistry, ProviderStreamEvent, StreamResult, Usage, WireMessage,
    },
    vault::Vault,
    vault_writer::{self, AssistantWrite, PersistedToolUse},
};

const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const BROADCAST_CAP: usize = 256;
const MAX_THINKING_BYTES: usize = 128 * 1024;
const THINKING_TRUNCATED_MARKER: &str = "[earlier thinking truncated]\n";

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
    /// Provider-supplied reasoning, kept only in the in-memory session buffer.
    /// It is replayable while the session lives but never enters StreamResult
    /// or vault persistence.
    pub full_thinking: String,
    pub started_at_ms: i64,
    pub thinking_duration_ms: Option<u64>,
    pub final_result: Option<StreamResult>,
    pub final_title: Option<String>,
    pub error_message: Option<String>,
    /// Tool calls/results observed during this session — replayed to late
    /// subscribers along with the accumulated text content.
    pub tool_history: Vec<ToolHistoryEntry>,
    /// Per-session secret the `/api/mcp` endpoint checks before executing tools
    /// on this session's behalf (used by the Claude Code MCP bridge).
    pub mcp_token: String,
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
    Thinking(String),
    ThinkingDone(u64),
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

fn append_bounded_thinking(buffer: &mut String, delta: &str) {
    buffer.push_str(delta);
    if buffer.len() <= MAX_THINKING_BYTES {
        return;
    }
    let keep = MAX_THINKING_BYTES.saturating_sub(THINKING_TRUNCATED_MARKER.len());
    let mut start = buffer.len().saturating_sub(keep);
    while start < buffer.len() && !buffer.is_char_boundary(start) {
        start += 1;
    }
    let tail = buffer[start..].to_string();
    buffer.clear();
    buffer.push_str(THINKING_TRUNCATED_MARKER);
    buffer.push_str(&tail);
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

    /// Register a minimal streaming session for tests (e.g. the MCP auth check).
    #[cfg(test)]
    pub(crate) fn insert_test_session(
        &self,
        id: &str,
        conversation_id: &str,
        message_id: &str,
        mcp_token: &str,
    ) {
        let (tx, _) = broadcast::channel::<SessionEvent>(BROADCAST_CAP);
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(Session {
            inner: Mutex::new(SessionInner {
                conversation_id: conversation_id.into(),
                assistant_message_id: message_id.into(),
                status: SessionStatus::Streaming,
                full_content: String::new(),
                full_thinking: String::new(),
                started_at_ms: chrono::Utc::now().timestamp_millis(),
                thinking_duration_ms: None,
                final_result: None,
                final_title: None,
                error_message: None,
                tool_history: Vec::new(),
                mcp_token: mcp_token.into(),
            }),
            tx,
            cancel,
        });
        self.insert(id.into(), session);
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
    /// Name of a vault skill the user explicitly invoked for this turn (via a
    /// `/skill_name` slash command). Its instructions are appended to the system
    /// prompt; unknown/missing skills are ignored.
    #[serde(rename = "invokeSkill", default)]
    pub invoke_skill: Option<String>,
    /// Skip appending the assistant message to a conversation YAML.
    /// Used by scheduled tasks (whose results live in `tasks/*.yaml`, not
    /// `conversations/*.yaml`) and other programmatic callers that
    /// don't have a conversation file at all.
    #[serde(rename = "skipPersist", default)]
    pub skip_persist: bool,
}

/// Start a new streaming session. Returns the registered session immediately;
/// the stream runs in the background.
#[allow(clippy::too_many_arguments)]
pub fn start_session(
    registry: &SessionRegistry,
    providers: ProviderRegistry,
    vault: Arc<Vault>,
    tools: Arc<ToolRegistry>,
    model_cache: Arc<ModelCache>,
    compaction: CompactionSettings,
    self_base_url: Option<String>,
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
            full_thinking: String::new(),
            started_at_ms: chrono::Utc::now().timestamp_millis(),
            thinking_duration_ms: None,
            final_result: None,
            final_title: None,
            error_message: None,
            tool_history: Vec::new(),
            mcp_token: uuid::Uuid::new_v4().to_string(),
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
            self_base_url,
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
    self_base_url: Option<String>,
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

    let (delta_tx, mut delta_rx) = mpsc::unbounded_channel::<ProviderStreamEvent>();

    // Keep visible content and provider-supplied thinking on separate channels.
    // Thinking is bounded and replayable but never copied into the final result.
    let session_pump = session.clone();
    let pump = tokio::spawn(async move {
        while let Some(delta) = delta_rx.recv().await {
            match delta {
                ProviderStreamEvent::Thinking(text) => {
                    {
                        let mut inner = session_pump.inner.lock().unwrap();
                        append_bounded_thinking(&mut inner.full_thinking, &text);
                    }
                    let _ = session_pump.tx.send(SessionEvent::Thinking(text));
                }
                ProviderStreamEvent::Content(text) => {
                    let thinking_done = {
                        let mut inner = session_pump.inner.lock().unwrap();
                        let done =
                            if !text.trim().is_empty() && inner.thinking_duration_ms.is_none() {
                                let elapsed =
                                    chrono::Utc::now().timestamp_millis() - inner.started_at_ms;
                                let duration = elapsed.max(0) as u64;
                                inner.thinking_duration_ms = Some(duration);
                                Some(duration)
                            } else {
                                None
                            };
                        inner.full_content.push_str(&text);
                        done
                    };
                    if let Some(duration) = thinking_done {
                        let _ = session_pump.tx.send(SessionEvent::ThinkingDone(duration));
                    }
                    let _ = session_pump.tx.send(SessionEvent::Chunk(text));
                }
            }
        }
    });

    // Sink that forwards tool events through the broadcast channel and also
    // appends them to the session's tool_history for late-subscriber replay.
    let sink: Arc<dyn ToolEventSink> = Arc::new(SessionToolSink {
        session: session.clone(),
    });

    // Explicit `/skill_name` invocation: append the skill's instructions to this
    // turn's system prompt (the backend owns the vault skills — same source as
    // the `use_skill` tool). Unknown/missing skills are ignored.
    let system_prompt = apply_invoked_skill(
        params.system_prompt.clone(),
        params.invoke_skill.as_deref(),
        &tools.skills,
    );
    // Local models get read access to the private mounts — tell them the mounts
    // exist (external absolute paths aren't otherwise discoverable). Gated on
    // local-ness so cloud models never learn these directories exist.
    let system_prompt = apply_private_dirs_hint(
        system_prompt,
        &tools.config,
        crate::local::model_is_local(&tools.config, &params.model),
    );
    // Strip the leading `/skill_name` token from the user message before it
    // reaches the provider — otherwise the Claude Code CLI treats it as one of
    // its own slash commands ("Unknown command: /skill_name"). The skill is
    // already applied via the system prompt; the frontend keeps the original
    // text for display.
    let messages = strip_invocation_prefix(params.messages.clone(), params.invoke_skill.as_deref());

    // Compaction: build the send view (folding older turns into a summary when
    // over budget). Returns the messages to send plus an optional summary to
    // persist at completion. Never compact when there's no conversation file to
    // persist into (skip_persist) — but the in-memory send view is still built.
    let cw = model_cache.context_window_for(&params.model);
    let prepared = compaction::prepare(
        &messages,
        system_prompt.as_deref(),
        Some(vault.as_ref()),
        provider.as_ref(),
        &upstream_model,
        cw,
        &compaction,
    )
    .await;
    let messages = prepared.send;
    // Only persist a freshly-generated compacted message when we own a
    // conversation file (scheduled tasks/riffs use skip_persist and ephemeral
    // histories).
    let new_compacted: Option<NewCompacted> = if params.skip_persist {
        None
    } else {
        prepared.new_compacted
    };

    // MCP bridge for the Claude Code provider: lets it call Alloy's built-in
    // tools (via /api/mcp) instead of Claude Code's native tools. Only built
    // when we know our own URL; ignored by every other provider.
    let mcp = self_base_url.map(|base_url| McpBridge {
        base_url,
        session_id: params.session_id.clone(),
        token: session.inner.lock().unwrap().mcp_token.clone(),
    });

    let loop_req = LoopRequest {
        provider: provider.clone(),
        model: upstream_model.clone(),
        messages,
        tools: if provider.supports_tools(&upstream_model) {
            builtin_tools()
        } else {
            Vec::new()
        },
        delta_tx,
        cancel: cancel.clone(),
        tool_ctx: ToolContext {
            message_id: Some(session.inner.lock().unwrap().assistant_message_id.clone()),
            conversation_id: Some(format!("conversations/{}", params.conversation_id)),
            inside_subagent: false,
            model_is_local: crate::local::model_is_local(&tools.config, &params.model),
        },
        mcp,
    };

    let started = std::time::Instant::now();
    let result = execute_with_tools(loop_req, tools, sink).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let _ = pump.await;

    match result {
        Ok(mut stream_result) => {
            // Compute USD cost from cached pricing (sourced from OpenRouter's
            // /models endpoint via ModelCache). If the model isn't in the
            // cache yet — first conversation before /api/models ran — cost
            // stays unset. Also stamp the wall-clock turn duration.
            if let Some(usage) = stream_result.usage.as_mut() {
                if let Some((in_per_m, out_per_m)) = model_cache.pricing_for(&params.model) {
                    let cost = (usage.input_tokens as f64 * in_per_m
                        + usage.output_tokens as f64 * out_per_m)
                        / 1_000_000.0;
                    usage.cost = Some(cost);
                }
                usage.duration_ms = Some(duration_ms);
            }

            if !params.skip_persist {
                let (assistant_message_id, tool_use) = {
                    let inner = session.inner.lock().unwrap();
                    (
                        inner.assistant_message_id.clone(),
                        collect_tool_uses(&inner.tool_history),
                    )
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
                inner.full_thinking.clear();
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

/// Append an explicitly-invoked (`/skill_name`) skill's instructions to a turn's
/// system prompt. A missing/blank name or an unknown skill leaves the prompt
/// unchanged.
fn apply_invoked_skill(
    system: Option<String>,
    invoke_skill: Option<&str>,
    skills: &crate::skill_registry::SkillRegistry,
) -> Option<String> {
    let Some(name) = invoke_skill.map(str::trim).filter(|s| !s.is_empty()) else {
        return system;
    };
    let Some(block) = crate::tools::skills::skill_block(skills, name) else {
        return system;
    };
    let directive = format!(
        "{block}\n\nThe user invoked this skill via a slash command — apply it to their message."
    );
    Some(match system {
        Some(s) if !s.trim().is_empty() => format!("{s}\n\n{directive}"),
        _ => directive,
    })
}

/// Append a description of the private read-only mounts, positioning them as the
/// user's primary knowledge base and disambiguating them from the app's own
/// `notes/`. Only for **local** models with at least one configured mount —
/// cloud models (and mount-less local models) get the system prompt untouched,
/// so cloud models never even learn these directories exist.
fn apply_private_dirs_hint(
    system: Option<String>,
    config: &crate::config::Config,
    model_is_local: bool,
) -> Option<String> {
    // INVARIANT: cloud models must never see this hint. Keep this early return.
    if !model_is_local || config.private_read_only_dirs.is_empty() {
        return system;
    }
    let lines = config
        .private_read_only_dirs
        .iter()
        .map(|d| {
            let desc = d
                .description
                .as_deref()
                .unwrap_or("the user's personal notes / knowledge base");
            format!("- `private/{}/` — {}", d.alias, desc)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let hint = format!(
        "The user's real notes / knowledge base live in these read-only directories \
         (local models only), searchable with read_file, list_directory, and search_directory:\n\
         {lines}\n\
         When the user asks about \"their notes\" or any personal topic, search these FIRST. \
         The vault's own `notes/` directory holds only notes created inside this app — it is NOT \
         the user's personal notes."
    );
    Some(match system {
        Some(s) if !s.trim().is_empty() => format!("{s}\n\n{hint}"),
        _ => hint,
    })
}

/// Remove the leading `/skill_name` token from the most recent user message so
/// providers (notably the Claude Code CLI) don't treat it as a slash command.
/// Only strips when the prefix is followed by whitespace or end-of-string.
fn strip_invocation_prefix(
    mut messages: Vec<WireMessage>,
    invoke_skill: Option<&str>,
) -> Vec<WireMessage> {
    let Some(name) = invoke_skill.map(str::trim).filter(|s| !s.is_empty()) else {
        return messages;
    };
    if let Some(m) = messages.iter_mut().rev().find(|m| m.role == "user") {
        let prefix = format!("/{name}");
        if let Some(rest) = m.content.strip_prefix(&prefix) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                m.content = rest.trim_start().to_string();
            }
        }
    }
    messages
}

fn mark_error(session: &Session, msg: String) {
    tracing::error!("session error: {}", msg);
    {
        let mut inner = session.inner.lock().unwrap();
        inner.status = SessionStatus::Error;
        inner.full_thinking.clear();
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
        if let ToolHistoryEntry::Result {
            tool_use_id,
            content,
            is_error,
        } = entry
        {
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
/// scheduled-task executor) that need to await completion synchronously rather
/// than fan events out over SSE.
#[derive(Debug, Clone)]
pub struct SessionOutcome {
    pub content: String,
    pub usage: Option<Usage>,
    pub stop_reason: String,
}

/// Run a streaming session and await its terminal event. Used by
/// programmatic callers (scheduled tasks, internal jobs) that want the final
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
    let session = start_session(
        registry,
        providers,
        vault,
        tools,
        model_cache,
        compaction,
        None,
        params,
    )?;
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
            // The Claude Code CLI takes a bare `--model` alias (the returned
            // string is passed straight through to `claude --model`); a
            // provider-prefixed id like "anthropic/claude-haiku-4-5" is rejected
            // and title generation falls back to the raw user message. Haiku
            // keeps the subscription cost low.
            "claude-cli" => return "haiku".to_string(),
            _ => {}
        }
    }
    "anthropic/claude-haiku-4-5".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;

    use crate::config::Config;
    use crate::providers::{Provider, StreamRequest};
    use crate::skill_registry::SkillRegistry;

    fn skills_with(name: &str, body: &str) -> SkillRegistry {
        let dir = tempfile::tempdir().unwrap();
        let sd = dir.path().join("skills").join(name);
        std::fs::create_dir_all(&sd).unwrap();
        std::fs::write(
            sd.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\n\n{body}\n"),
        )
        .unwrap();
        let reg = SkillRegistry::new();
        reg.load(dir.path());
        reg
    }

    #[test]
    fn thinking_buffer_is_bounded_at_a_utf8_boundary() {
        let mut value = "é".repeat(MAX_THINKING_BYTES);
        append_bounded_thinking(&mut value, "tail");
        assert!(value.len() <= MAX_THINKING_BYTES);
        assert!(value.starts_with(THINKING_TRUNCATED_MARKER));
        assert!(value.ends_with("tail"));
    }

    struct ThinkingProvider;

    #[async_trait]
    impl Provider for ThinkingProvider {
        async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
            let _ = req
                .delta_tx
                .send(ProviderStreamEvent::Thinking("secret scratch work".into()));
            let _ = req
                .delta_tx
                .send(ProviderStreamEvent::Content("visible answer".into()));
            Ok(StreamResult {
                content: "visible answer".into(),
                usage: None,
                stop_reason: "end_turn".into(),
                tool_calls: vec![],
            })
        }

        async fn generate_title(&self, _user: &str, _assistant: &str, _model: &str) -> String {
            String::new()
        }

        fn supports_tools(&self, _model: &str) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn provider_thinking_never_enters_persisted_messages() {
        let dir = tempfile::tempdir().unwrap();
        let conversations = dir.path().join("conversations");
        std::fs::create_dir(&conversations).unwrap();
        let conversation_path = conversations.join("conv.yaml");
        std::fs::write(
            &conversation_path,
            "id: conv\nmodel: test/model\ncreated: now\nupdated: now\nmessages: []\n",
        )
        .unwrap();

        let vault = Arc::new(Vault::new(dir.path().to_path_buf()).unwrap());
        let providers = ProviderRegistry::from_test_provider("test", Arc::new(ThinkingProvider));
        let config = Arc::new(Config::default());
        let tools = Arc::new(ToolRegistry::new(
            config,
            vault.clone(),
            providers.clone(),
            Arc::new(SkillRegistry::new()),
        ));
        let sessions = SessionRegistry::new();
        let outcome = run_to_completion(
            &sessions,
            providers,
            vault,
            tools,
            Arc::new(ModelCache::new()),
            CompactionSettings::default(),
            StartParams {
                session_id: "session".into(),
                conversation_id: "conv".into(),
                assistant_message_id: Some("assistant".into()),
                model: "test/model".into(),
                messages: vec![user_msg("hello")],
                system_prompt: None,
                is_first_message: false,
                user_message_content: "hello".into(),
                invoke_skill: None,
                skip_persist: false,
            },
        )
        .await
        .unwrap();

        assert_eq!(outcome.content, "visible answer");
        let yaml = std::fs::read_to_string(conversation_path).unwrap();
        assert!(yaml.contains("visible answer"));
        assert!(!yaml.contains("secret scratch work"), "got:\n{yaml}");
        assert!(!yaml.contains("thinking:"), "got:\n{yaml}");
        let session = sessions.get("session").unwrap();
        assert!(session.inner.lock().unwrap().full_thinking.is_empty());
    }

    #[test]
    fn invoked_skill_appends_block_to_system_prompt() {
        let reg = skills_with("research", "Do deep research.");
        let out = apply_invoked_skill(Some("BASE".into()), Some("research"), &reg).unwrap();
        assert!(out.starts_with("BASE\n\n"));
        assert!(out.contains("# Skill: research"));
        assert!(out.contains("Do deep research."));
        assert!(out.contains("invoked this skill via a slash command"));
    }

    fn cfg_with_mount(desc: Option<&str>) -> crate::config::Config {
        crate::config::Config {
            private_read_only_dirs: vec![crate::config::PrivateDir {
                alias: "obsidian_vault".into(),
                path: "/Users/x/Notes".into(),
                exclude_dirs: vec![],
                description: desc.map(str::to_string),
            }],
            ..crate::config::Config::default()
        }
    }

    #[test]
    fn private_hint_local_uses_description_and_positions_as_primary() {
        let cfg = cfg_with_mount(Some("The user's Obsidian knowledge base."));
        let out = apply_private_dirs_hint(Some("BASE".into()), &cfg, true).unwrap();
        assert!(out.starts_with("BASE\n\n"));
        assert!(out.contains("private/obsidian_vault/"));
        assert!(out.contains("The user's Obsidian knowledge base."));
        assert!(out.contains("search these FIRST"));
        assert!(out.contains("NOT")); // disambiguates the app's notes/
    }

    #[test]
    fn private_hint_falls_back_without_description() {
        let cfg = cfg_with_mount(None);
        let out = apply_private_dirs_hint(Some("BASE".into()), &cfg, true).unwrap();
        assert!(out.contains("personal notes / knowledge base"));
    }

    // INVARIANT: cloud models must never see the private mounts.
    #[test]
    fn private_hint_never_shown_to_cloud_models() {
        let cfg = cfg_with_mount(Some("secret notes"));
        let out = apply_private_dirs_hint(Some("BASE".into()), &cfg, false);
        assert_eq!(out, Some("BASE".into())); // untouched
        assert!(!out.unwrap().contains("obsidian_vault"));
        // No mounts configured → also untouched, even for a local model.
        let empty = crate::config::Config::default();
        assert_eq!(
            apply_private_dirs_hint(Some("BASE".into()), &empty, true),
            Some("BASE".into())
        );
    }

    fn user_msg(content: &str) -> WireMessage {
        WireMessage {
            id: None,
            role: "user".into(),
            content: content.into(),
            attachments: vec![],
        }
    }

    #[test]
    fn strips_leading_slash_command_from_last_user_message() {
        let msgs = vec![user_msg("earlier"), user_msg("/flux-highlights\n\n# Body")];
        let out = strip_invocation_prefix(msgs, Some("flux-highlights"));
        assert_eq!(out[1].content, "# Body");
        assert_eq!(out[0].content, "earlier"); // earlier turns untouched

        // Bare command → empty content.
        let out = strip_invocation_prefix(vec![user_msg("/research")], Some("research"));
        assert_eq!(out[0].content, "");
    }

    #[test]
    fn strip_leaves_unrelated_or_partial_matches_alone() {
        // No invocation.
        let out = strip_invocation_prefix(vec![user_msg("/research foo")], None);
        assert_eq!(out[0].content, "/research foo");
        // Prefix not followed by whitespace (different skill) → untouched.
        let out = strip_invocation_prefix(vec![user_msg("/researchx foo")], Some("research"));
        assert_eq!(out[0].content, "/researchx foo");
    }

    #[test]
    fn invoked_skill_unknown_or_absent_leaves_prompt_unchanged() {
        let reg = skills_with("research", "x");
        // Unknown skill name → unchanged.
        assert_eq!(
            apply_invoked_skill(Some("BASE".into()), Some("nope"), &reg),
            Some("BASE".into())
        );
        // No invocation → unchanged.
        assert_eq!(
            apply_invoked_skill(Some("BASE".into()), None, &reg),
            Some("BASE".into())
        );
        // Blank name → unchanged.
        assert_eq!(
            apply_invoked_skill(Some("BASE".into()), Some("  "), &reg),
            Some("BASE".into())
        );
    }

    fn use_entry(id: &str, name: &str) -> ToolHistoryEntry {
        ToolHistoryEntry::Use {
            id: id.into(),
            name: name.into(),
            input: json!({ "q": id }),
        }
    }

    #[test]
    fn title_model_is_provider_appropriate() {
        // OpenRouter wants a vendor-prefixed Haiku id.
        assert_eq!(
            pick_title_model("openrouter/google/gemini-3.5-flash"),
            "anthropic/claude-haiku-4-5"
        );
        // Ollama is local — title with the same (local) model.
        assert_eq!(pick_title_model("ollama/llama3"), "ollama/llama3");
        // The Claude Code CLI takes a bare alias, not a provider-prefixed id.
        assert_eq!(pick_title_model("claude-cli/opus"), "haiku");
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
        assert!(
            !yaml_ok.contains("isError"),
            "success should omit isError:\n{yaml_ok}"
        );
    }
}
