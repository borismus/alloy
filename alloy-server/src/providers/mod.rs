//! Provider abstraction.
//!
//! HTTP providers use the `openai_compatible` kind (OpenRouter, oMLX, and
//! other compatible upstreams). Subscription CLIs use `kind: cli` with a
//! Claude or Codex adapter.

pub mod cli_claude;
pub mod cli_codex;
pub mod openai_compatible;

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::{CliAdapter, ProviderConfig, ProviderKind};
use crate::types::{ToolCall, ToolDefinition, ToolEventSink};
use crate::vault::Vault;

/// Incoming wire message from the SPA's /api/stream/start body — simple
/// user/assistant text. The tool loop builds richer internal messages
/// (`ChatMessage`) during execution.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WireMessage {
    /// Optional message id (carried so compaction can anchor a server-inserted
    /// `compacted` message at the right boundary in the vault array).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<WireAttachment>,
    /// When a user message was sent, pre-formatted in the user's local time by
    /// the SPA (which knows their timezone). Prefixed onto the message so the
    /// model can tell how much time passed between turns of a conversation
    /// resumed over days.
    #[serde(rename = "sentAt", default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<String>,
}

/// Attachment reference from the SPA (image, PDF, or Markdown). The bytes live
/// in the vault at `conversations/{path}`; the server reads them when building
/// the provider request (the SPA never ships the base64 over the wire).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WireAttachment {
    pub path: String,
    #[serde(rename = "mimeType", default)]
    pub mime_type: String,
    /// Original filename, shown to the model for PDFs and Markdown files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

pub const PDF_MIME: &str = "application/pdf";
const MARKDOWN_MIME: &str = "text/markdown";

/// A decoded binary attachment (image or PDF) ready to embed in a provider
/// request as base64. PDFs are sent as-is to providers that read them natively
/// and dropped for the rest — Alloy never extracts PDF text itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentData {
    pub mime_type: String,
    pub base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl AttachmentData {
    pub fn is_pdf(&self) -> bool {
        self.mime_type == PDF_MIME
    }

    /// Size of the original file, from its base64 encoding.
    pub fn decoded_len(&self) -> u64 {
        let padding = self.base64.bytes().rev().take_while(|b| *b == b'=').count();
        (self.base64.len() / 4 * 3).saturating_sub(padding) as u64
    }

    pub fn filename(&self) -> &str {
        self.name.as_deref().unwrap_or("document.pdf")
    }
}

/// Provider-internal message format. Supports OpenAI tool-calling: assistant
/// turns may have empty content + tool_calls, and tool result turns use the
/// `tool` role with a tool_call_id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatMessage {
    System {
        content: String,
    },
    User {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<AttachmentData>,
    },
    Assistant {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<AssistantToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub typ: String,
    pub function: AssistantToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantToolFunction {
    pub name: String,
    /// Raw JSON-encoded arguments string, as required by OpenAI's wire format.
    pub arguments: String,
}

impl ChatMessage {
    /// Build the assistant-turn `ChatMessage` from a stream result that
    /// contained tool calls (used by the tool loop to continue the
    /// conversation).
    pub fn assistant_from_result(content: String, tool_calls: &[ToolCall]) -> Self {
        let assistant_calls = tool_calls
            .iter()
            .map(|tc| AssistantToolCall {
                id: tc.id.clone(),
                typ: "function".into(),
                function: AssistantToolFunction {
                    name: tc.name.clone(),
                    arguments: serde_json::to_string(&tc.input).unwrap_or_else(|_| "{}".into()),
                },
            })
            .collect();
        ChatMessage::Assistant {
            content,
            tool_calls: assistant_calls,
        }
    }

    pub fn tool_result(tool_call_id: String, content: String) -> Self {
        ChatMessage::Tool {
            tool_call_id,
            content,
        }
    }
}

/// Convert a wire message vec from the SPA into ChatMessages, prepending a
/// system message if provided.
pub async fn wire_to_chat(
    messages: &[WireMessage],
    system_prompt: Option<&str>,
    vault: Option<&Vault>,
) -> Vec<ChatMessage> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    if let Some(s) = system_prompt.filter(|s| !s.is_empty()) {
        out.push(ChatMessage::System {
            content: s.to_string(),
        });
    }
    for m in messages {
        match m.role.as_str() {
            "assistant" => out.push(ChatMessage::Assistant {
                content: m.content.clone(),
                tool_calls: Vec::new(),
            }),
            "log" => {} // skip
            _ => out.push(resolve_user_message(vault, m).await),
        }
    }
    out
}

/// Build a user turn from a wire message, reading its attachments from the
/// vault (`conversations/{path}`). Images and PDFs are base64-encoded; Markdown
/// files are plain text, so their contents are appended to the message text
/// where every provider can see them. Missing/unreadable files are logged and
/// skipped so a stale attachment reference can't break the whole turn. No vault
/// (e.g. sub-agent calls) means no attachments.
async fn resolve_user_message(vault: Option<&Vault>, m: &WireMessage) -> ChatMessage {
    let mut content = match &m.sent_at {
        Some(sent_at) => format!("[{sent_at}]\n{}", m.content),
        None => m.content.clone(),
    };
    let mut attachments = Vec::new();
    if let Some(vault) = vault {
        for att in &m.attachments {
            let path = match vault.resolve(&format!("conversations/{}", att.path)) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("skipping attachment {}: {}", att.path, e);
                    continue;
                }
            };
            let bytes = match tokio::fs::read(&path).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    tracing::warn!("failed to read attachment {}: {}", att.path, e);
                    continue;
                }
            };
            if att.mime_type == MARKDOWN_MIME {
                let name = att.name.as_deref().unwrap_or("attachment.md");
                content.push_str(&format!(
                    "\n\n<file name=\"{}\">\n{}\n</file>",
                    name,
                    String::from_utf8_lossy(&bytes).trim_end()
                ));
            } else {
                attachments.push(AttachmentData {
                    mime_type: att.mime_type.clone(),
                    base64: B64.encode(&bytes),
                    name: att.name.clone(),
                });
            }
        }
    }
    ChatMessage::User {
        content,
        attachments,
    }
}

/// Model metadata discovered by a provider adapter. The `/api/models` route
/// adds the configured provider id and privacy/pricing metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    /// Upstream model id or CLI alias passed back to this provider.
    pub id: String,
    pub name: String,
    pub context_window: Option<u64>,
    /// Whether the upstream currently chooses this model when no model is given.
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Usage {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u32,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u32,
    #[serde(rename = "responseId", skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Wall-clock time (ms) to produce this turn — model generation plus any
    /// tool-loop iterations. Filled in by the streaming session; shown in the
    /// message footer.
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Number of pre-response connection retries recovered during this turn.
    #[serde(rename = "connectionRetries", default, skip_serializing_if = "is_zero")]
    pub connection_retries: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamResult {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(rename = "stopReason")]
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderStreamEvent {
    Content(String),
    Thinking(String),
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

pub struct StreamRequest {
    pub messages: Vec<ChatMessage>,
    pub model: String,
    pub tools: Vec<ToolDefinition>,
    pub delta_tx: mpsc::UnboundedSender<ProviderStreamEvent>,
    pub cancel: tokio::sync::watch::Receiver<bool>,
    /// Retry only failures that occur while establishing the provider HTTP
    /// connection. Enabled for task execution, never ordinary chat.
    pub retry_connect: bool,
    /// Sink for providers that run their own tool loop (the Claude Code CLI) to
    /// surface `tool_use`/`tool_result` events. HTTP providers ignore it — their
    /// tool calls are executed and emitted by `tool_loop::execute_with_tools`.
    pub tool_sink: Arc<dyn ToolEventSink>,
    /// Coordinates for the Claude Code provider to reach Alloy's MCP bridge, so
    /// it calls Alloy's built-in tools instead of Claude Code's native ones.
    /// `None` for HTTP providers (and when the server URL isn't known yet).
    pub mcp: Option<McpBridge>,
    /// Resolved internal limits. Provider adapters use the portions their
    /// protocol supports (for example OpenAI `max_tokens` and Claude max turns).
    pub execution_policy: crate::execution_policy::ExecutionPolicy,
}

/// How the Claude Code CLI reaches back into this server's MCP endpoint for one
/// streaming session. Built in `run_stream`; consumed by `cli_claude`.
#[derive(Debug, Clone)]
pub struct McpBridge {
    /// This server's loopback base URL, e.g. `http://127.0.0.1:3001`.
    pub base_url: String,
    /// The streaming session id (correlates MCP tool calls to the session).
    pub session_id: String,
    /// Per-session secret the MCP endpoint verifies before executing tools.
    pub token: String,
}

pub(crate) fn fallback_title(user_msg: &str) -> String {
    user_msg.chars().take(50).collect()
}

/// Normalize a model-generated title across provider protocols. Reasoning
/// models occasionally return chain-of-thought or formatting despite the
/// title-only prompt; keep that out of the timeline and filename.
pub(crate) fn sanitize_title(raw: &str, user_msg: &str) -> String {
    let stripped = strip_think_blocks(raw);
    let first_line = stripped
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '*' || c == '#')
        .trim();

    let nonblank_lines = stripped.lines().filter(|l| !l.trim().is_empty()).count();
    let lower = stripped.to_lowercase();
    let reads_like_reasoning = first_line.is_empty()
        || first_line.chars().count() > 80
        || first_line.ends_with(':')
        || nonblank_lines > 2
        || [
            "thinking process",
            "analyze user",
            "the user is asking",
            "the user wants",
            "here's a",
            "here is a",
            "let me ",
            "first, i",
            "okay, so",
            "step 1",
        ]
        .iter()
        .any(|m| lower.contains(m));

    if reads_like_reasoning {
        fallback_title(user_msg)
    } else {
        first_line.chars().take(100).collect()
    }
}

/// Remove `<think>…</think>` / `<thinking>…</thinking>` spans, including an
/// unclosed trailing block (which a token limit can produce).
pub(crate) fn strip_think_blocks(s: &str) -> String {
    let mut out = s.to_string();
    for (open, close) in [("<think>", "</think>"), ("<thinking>", "</thinking>")] {
        while let Some(start) = out.find(open) {
            match out[start + open.len()..].find(close) {
                Some(rel) => {
                    let end = start + open.len() + rel + close.len();
                    out.replace_range(start..end, "");
                }
                None => {
                    out.truncate(start);
                    break;
                }
            }
        }
    }
    out
}

#[async_trait]
pub trait Provider: Send + Sync {
    /// Stream a chat completion. Send visible content and provider-supplied
    /// thinking as separate deltas; return only visible content on completion.
    /// If the model emits tool calls, `tool_calls` in the result is populated
    /// and `stop_reason` is "tool_use".
    async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult>;

    /// Pick the provider-native model identifier used for title generation.
    /// The input has already had Alloy's configured provider prefix removed.
    /// HTTP-compatible providers normally reuse it; subscription adapters can
    /// select a cheap/account-default alias without leaking another provider's
    /// model id into their CLI.
    fn title_model(&self, conversation_model: &str) -> String {
        conversation_model.to_string()
    }

    /// Generate a short title (3-6 words) from the first exchange.
    async fn generate_title(&self, user_msg: &str, assistant_msg: &str, model: &str) -> String;

    /// One-shot, non-streaming completion. Used by compaction to generate a
    /// conversation summary. Returns `None` on any failure so the caller can
    /// fall back gracefully. Default impl returns `None`.
    async fn complete_once(
        &self,
        _system: &str,
        _user: &str,
        _model: &str,
        _max_tokens: u32,
    ) -> Option<String> {
        None
    }

    /// Does this provider+model support tool calling? Used by the streaming
    /// session to decide whether to include the `tools` array. Default is
    /// optimistic (yes); concrete impls override.
    fn supports_tools(&self, _model: &str) -> bool {
        true
    }

    /// Can this provider+model accept image attachments? Surfaced through
    /// `/api/models` so the composer can refuse an attachment up front instead
    /// of dropping it silently mid-request — a text-only provider otherwise
    /// answers the bare text as if no image had been sent. Default is
    /// optimistic (yes); concrete impls override.
    fn supports_images(&self, _model: &str) -> bool {
        true
    }

    /// Can this provider+model read PDF attachments natively? Alloy never
    /// extracts PDF text itself, so providers that can't read PDFs have them
    /// dropped before the request and the composer refuses them up front.
    /// Default is no; concrete impls override.
    fn supports_pdfs(&self, _model: &str) -> bool {
        false
    }

    /// Largest PDF this provider is known to deliver, in bytes, when it has a
    /// limit it enforces silently rather than by returning an error. Surfaced
    /// through `/api/models` so the composer can warn, and enforced by the
    /// provider so an oversized PDF fails the turn instead of vanishing.
    fn max_pdf_bytes(&self, _model: &str) -> Option<u64> {
        None
    }
}

pub type ProviderArc = Arc<dyn Provider>;

/// Provider-id prefixes the SPA emits in model keys. Kept in sync with
/// `ProviderType` in [src/types/index.ts](src/types/index.ts). Used by
/// `resolve()` to distinguish "user wrote a bad model id with a real
/// provider prefix" (→ fail loudly) from "user wrote a bare/vendor model
/// id" (→ fall through to the default provider).
const KNOWN_PROVIDER_IDS: &[&str] = &[
    "anthropic",
    "openai",
    "gemini",
    "grok",
    "openrouter",
    "claude-cli",
    "codex-cli",
    "mlx",
];

/// Registry mapping provider ids (for example `openrouter` or `mlx`) to clients.
#[derive(Clone)]
pub struct ProviderRegistry {
    by_id: HashMap<String, ProviderArc>,
    default_id: Option<String>,
}

impl ProviderRegistry {
    #[cfg(test)]
    pub(crate) fn from_test_provider(id: &str, provider: ProviderArc) -> Self {
        Self {
            by_id: HashMap::from([(id.to_string(), provider)]),
            default_id: Some(id.to_string()),
        }
    }

    pub fn from_configs(configs: &[ProviderConfig]) -> Self {
        let mut by_id: HashMap<String, ProviderArc> = HashMap::new();
        let mut default_id = None;
        for cfg in configs {
            let Some(provider) = build_provider(cfg) else {
                // Config::load rejects this; keep programmatic/test-built
                // registries defensive rather than panicking.
                tracing::error!("CLI provider '{}' has no adapter; skipping", cfg.id);
                continue;
            };
            if default_id.is_none() {
                default_id = Some(cfg.id.clone());
            }
            by_id.insert(cfg.id.clone(), provider);
        }
        Self { by_id, default_id }
    }

    /// Given a model id from the SPA (e.g. "anthropic/claude-sonnet-4-6" or
    /// "openrouter/anthropic/claude-sonnet-4-6"), pick the provider and
    /// return the upstream model id.
    ///
    /// Rules:
    /// - Prefix matches a *registered* provider id → use it, strip the prefix.
    /// - Prefix is a *known* alloy provider name (e.g. "anthropic", "openai")
    ///   that isn't registered → return Err with a config-pointing message.
    ///   This catches the common bug of a stale `defaultModel` pointing at a
    ///   provider that was never set up (which used to silently route to the
    ///   default and 400 upstream).
    /// - No slash, or prefix that doesn't look like an alloy provider id →
    ///   route to the default provider verbatim. Preserves backward compat
    ///   for unprefixed model ids and for vendor/model pairs like
    ///   `google/gemini-2.5-flash` that OpenRouter accepts directly.
    pub fn resolve<'a>(&'a self, model: &'a str) -> Result<(ProviderArc, &'a str), String> {
        if let Some((first, rest)) = model.split_once('/') {
            if let Some(p) = self.by_id.get(first) {
                return Ok((p.clone(), rest));
            }
            if KNOWN_PROVIDER_IDS.contains(&first) {
                let mut configured: Vec<&str> = self.by_id.keys().map(String::as_str).collect();
                configured.sort();
                let configured = if configured.is_empty() {
                    "none".to_string()
                } else {
                    configured.join(", ")
                };
                return Err(format!(
                    "Model '{}' wants the '{}' provider, but only [{}] are configured. \
                     Update `defaultModel` in config.yaml (or pick a different model) \
                     so the prefix matches a configured provider.",
                    model, first, configured
                ));
            }
        }
        let default = self.default_id.as_ref().ok_or_else(|| {
            "No providers configured. Set OPENROUTER_API_KEY in config.yaml.".to_string()
        })?;
        let p = self
            .by_id
            .get(default)
            .cloned()
            .ok_or_else(|| format!("internal: default provider '{}' missing", default))?;
        Ok((p, model))
    }

    pub fn default_provider(&self) -> Option<(String, ProviderArc)> {
        let id = self.default_id.clone()?;
        let p = self.by_id.get(&id)?.clone();
        Some((id, p))
    }

    /// All registered providers and their configs (for /api/models aggregation).
    pub fn ids(&self) -> Vec<String> {
        self.by_id.keys().cloned().collect()
    }
}

/// Construct the provider for one config. `None` only for a CLI provider with
/// no adapter.
pub fn build_provider(cfg: &ProviderConfig) -> Option<ProviderArc> {
    Some(match cfg.kind {
        ProviderKind::OpenaiCompatible => {
            Arc::new(openai_compatible::OpenAICompatibleProvider::new(cfg))
        }
        ProviderKind::Cli => match cfg.adapter {
            Some(CliAdapter::Claude) => Arc::new(cli_claude::CliClaudeProvider::new(cfg)),
            Some(CliAdapter::Codex) => Arc::new(cli_codex::CliCodexProvider::new(cfg)),
            None => return None,
        },
    })
}

// Used by the openai_compatible impl for serializing messages.
pub(crate) fn chat_messages_to_openai(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| match m {
            ChatMessage::System { content } => serde_json::json!({
                "role": "system",
                "content": content,
            }),
            ChatMessage::User {
                content,
                attachments,
            } => {
                if attachments.is_empty() {
                    serde_json::json!({ "role": "user", "content": content })
                } else {
                    let mut parts = vec![serde_json::json!({ "type": "text", "text": content })];
                    parts.extend(attachment_content_blocks(attachments));
                    serde_json::json!({ "role": "user", "content": parts })
                }
            }
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                let mut obj = serde_json::Map::new();
                obj.insert("role".into(), serde_json::json!("assistant"));
                // OpenAI accepts content: null when only tool_calls are present.
                if content.is_empty() && !tool_calls.is_empty() {
                    obj.insert("content".into(), Value::Null);
                } else {
                    obj.insert("content".into(), serde_json::json!(content));
                }
                if !tool_calls.is_empty() {
                    obj.insert(
                        "tool_calls".into(),
                        serde_json::to_value(tool_calls).unwrap_or(Value::Null),
                    );
                }
                Value::Object(obj)
            }
            ChatMessage::Tool {
                tool_call_id,
                content,
            } => serde_json::json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content,
            }),
        })
        .collect()
}

/// Build OpenAI-style content blocks from decoded attachments. Shared by the
/// plain OpenAI path and the Anthropic-caching path — both target an
/// OpenAI-compatible upstream (OpenRouter), so the wire shape is the same
/// (`image_url` / `file` with a base64 data URL); only `cache_control` markers
/// differ.
pub(crate) fn attachment_content_blocks(attachments: &[AttachmentData]) -> Vec<Value> {
    attachments
        .iter()
        .map(|att| {
            let data_url = format!("data:{};base64,{}", att.mime_type, att.base64);
            if att.is_pdf() {
                serde_json::json!({
                    "type": "file",
                    "file": { "filename": att.filename(), "file_data": data_url },
                })
            } else {
                serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": data_url },
                })
            }
        })
        .collect()
}

/// Drop PDF attachments from every user turn. Used when the selected provider
/// can't read PDFs natively — e.g. a conversation that attached a PDF on Claude
/// and then switched to Codex.
pub fn strip_pdfs(messages: &mut [ChatMessage]) {
    for m in messages {
        if let ChatMessage::User { attachments, .. } = m {
            attachments.retain(|att| !att.is_pdf());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prefixes_user_turns_with_their_send_time() {
        let wire = |role: &str| WireMessage {
            id: None,
            role: role.into(),
            content: "how is the fever now".into(),
            attachments: Vec::new(),
            sent_at: Some("Sat, Sep 19, 2026, 8:16 PM".into()),
        };
        let chat = wire_to_chat(&[wire("user"), wire("assistant")], None, None).await;
        let ChatMessage::User { content, .. } = &chat[0] else {
            panic!("expected user turn");
        };
        assert_eq!(
            content,
            "[Sat, Sep 19, 2026, 8:16 PM]\nhow is the fever now"
        );
        // Only user turns are stamped; the model shouldn't learn to echo stamps.
        let ChatMessage::Assistant { content, .. } = &chat[1] else {
            panic!("expected assistant turn");
        };
        assert_eq!(content, "how is the fever now");
    }

    #[tokio::test]
    async fn inlines_markdown_and_keeps_pdfs_as_attachments() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("conversations/attachments");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("c-file-001.md"), "# Notes\n\nhello\n").unwrap();
        std::fs::write(dir.join("c-file-002.pdf"), b"%PDF-1.4").unwrap();
        let vault = Vault::new(temp.path().to_path_buf()).unwrap();
        let wire = WireMessage {
            id: None,
            role: "user".into(),
            content: "read these".into(),
            attachments: vec![
                WireAttachment {
                    path: "attachments/c-file-001.md".into(),
                    mime_type: "text/markdown".into(),
                    name: Some("notes.md".into()),
                },
                WireAttachment {
                    path: "attachments/c-file-002.pdf".into(),
                    mime_type: "application/pdf".into(),
                    name: Some("paper.pdf".into()),
                },
            ],
            sent_at: None,
        };
        let mut chat = wire_to_chat(&[wire], None, Some(&vault)).await;
        let ChatMessage::User {
            content,
            attachments,
        } = &chat[0]
        else {
            panic!("expected user turn");
        };
        assert_eq!(
            content,
            "read these\n\n<file name=\"notes.md\">\n# Notes\n\nhello\n</file>"
        );
        assert_eq!(attachments.len(), 1);
        assert!(attachments[0].is_pdf());

        let blocks = attachment_content_blocks(attachments);
        assert_eq!(blocks[0]["type"], "file");
        assert_eq!(blocks[0]["file"]["filename"], "paper.pdf");

        strip_pdfs(&mut chat);
        let ChatMessage::User { attachments, .. } = &chat[0] else {
            unreachable!()
        };
        assert!(attachments.is_empty());
    }

    fn openrouter_only() -> ProviderRegistry {
        ProviderRegistry::from_configs(&[ProviderConfig {
            id: "openrouter".into(),
            kind: ProviderKind::OpenaiCompatible,
            adapter: None,
            base_url: Some("https://openrouter.ai/api/v1".into()),
            api_key: "test".into(),
            command: None,
            oauth_token: None,
            local: None,
        }])
    }

    #[test]
    fn resolve_strips_prefix_for_registered_provider() {
        let r = openrouter_only();
        let (_, upstream) = r.resolve("openrouter/anthropic/claude-sonnet-4.5").unwrap();
        assert_eq!(upstream, "anthropic/claude-sonnet-4.5");
    }

    #[test]
    fn resolve_fails_loudly_when_prefix_names_unregistered_provider() {
        let r = openrouter_only();
        let err = match r.resolve("anthropic/claude-sonnet-4-6") {
            Ok(_) => panic!("expected error"),
            Err(e) => e,
        };
        assert!(
            err.contains("'anthropic'"),
            "error should name the wanted provider: {err}"
        );
        assert!(
            err.contains("openrouter"),
            "error should list configured providers: {err}"
        );
        assert!(
            err.contains("config.yaml"),
            "error should point at config.yaml: {err}"
        );
    }

    #[test]
    fn resolve_falls_through_for_vendor_prefix_or_bare_id() {
        let r = openrouter_only();
        // OpenRouter accepts `google/gemini-2.5-flash` directly; not an alloy
        // provider id, so we route to default verbatim.
        let (_, upstream) = r.resolve("google/gemini-2.5-flash").unwrap();
        assert_eq!(upstream, "google/gemini-2.5-flash");
        // Bare id with no slash: legacy unprefixed configs.
        let (_, upstream) = r.resolve("claude-sonnet").unwrap();
        assert_eq!(upstream, "claude-sonnet");
    }

    #[test]
    fn resolve_errors_when_no_providers_configured() {
        let r = ProviderRegistry::from_configs(&[]);
        let err = match r.resolve("google/gemini-2.5-flash") {
            Ok(_) => panic!("expected error"),
            Err(e) => e,
        };
        assert!(err.contains("No providers configured"), "{err}");
    }
}
