//! Provider abstraction.
//!
//! Phase 1 only ships the `openai_compatible` kind (used for OpenRouter,
//! Ollama, and any other OpenAI-compatible upstream). Future kinds
//! (Anthropic native, Gemini native) plug in as additional impls.

pub mod cli_claude;
pub mod openai_compatible;

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::{ProviderConfig, ProviderKind};
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
}

/// Image attachment reference from the SPA. The bytes live in the vault at
/// `conversations/{path}`; the server reads + base64-encodes them when building
/// the provider request (the SPA never ships the base64 over the wire).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WireAttachment {
    pub path: String,
    #[serde(rename = "mimeType", default)]
    pub mime_type: String,
}

/// A decoded image ready to embed in a provider request as a base64 data URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageData {
    pub mime_type: String,
    pub base64: String,
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
        images: Vec<ImageData>,
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
            "user" => out.push(ChatMessage::User {
                content: m.content.clone(),
                images: resolve_images(vault, &m.attachments).await,
            }),
            "assistant" => out.push(ChatMessage::Assistant {
                content: m.content.clone(),
                tool_calls: Vec::new(),
            }),
            "log" => {} // skip
            _ => out.push(ChatMessage::User {
                content: m.content.clone(),
                images: resolve_images(vault, &m.attachments).await,
            }),
        }
    }
    out
}

/// Read each image attachment from the vault (`conversations/{path}`) and
/// base64-encode it. Missing/unreadable files are logged and skipped so a
/// stale attachment reference can't break the whole turn. Returns empty when
/// no vault is available (e.g. sub-agent calls) or there are no attachments.
async fn resolve_images(vault: Option<&Vault>, attachments: &[WireAttachment]) -> Vec<ImageData> {
    let Some(vault) = vault else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(attachments.len());
    for att in attachments {
        let path = match vault.resolve(&format!("conversations/{}", att.path)) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("skipping attachment {}: {}", att.path, e);
                continue;
            }
        };
        match tokio::fs::read(&path).await {
            Ok(bytes) => out.push(ImageData {
                mime_type: att.mime_type.clone(),
                base64: B64.encode(&bytes),
            }),
            Err(e) => tracing::warn!("failed to read attachment {}: {}", att.path, e),
        }
    }
    out
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

pub struct StreamRequest {
    pub messages: Vec<ChatMessage>,
    pub model: String,
    pub tools: Vec<ToolDefinition>,
    pub chunk_tx: mpsc::UnboundedSender<String>,
    pub cancel: tokio::sync::watch::Receiver<bool>,
    /// Sink for providers that run their own tool loop (the Claude Code CLI) to
    /// surface `tool_use`/`tool_result` events. HTTP providers ignore it — their
    /// tool calls are executed and emitted by `tool_loop::execute_with_tools`.
    pub tool_sink: Arc<dyn ToolEventSink>,
    /// Coordinates for the Claude Code provider to reach Alloy's MCP bridge, so
    /// it calls Alloy's built-in tools instead of Claude Code's native ones.
    /// `None` for HTTP providers (and when the server URL isn't known yet).
    pub mcp: Option<McpBridge>,
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

#[async_trait]
pub trait Provider: Send + Sync {
    /// Stream a chat completion. Send incremental text deltas via the
    /// provided mpsc channel; return the aggregated result on completion.
    /// If the model emits tool calls, `tool_calls` in the result is populated
    /// and `stop_reason` is "tool_use".
    async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult>;

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
}

pub type ProviderArc = Arc<dyn Provider>;

/// Provider-id prefixes the SPA emits in model keys. Kept in sync with
/// `ProviderType` in [src/types/index.ts](src/types/index.ts). Used by
/// `resolve()` to distinguish "user wrote a bad model id with a real
/// provider prefix" (→ fail loudly) from "user wrote a bare/vendor model
/// id" (→ fall through to the default provider).
const KNOWN_PROVIDER_IDS: &[&str] = &[
    "anthropic", "openai", "ollama", "gemini", "grok", "openrouter", "claude-cli", "mlx",
];

/// Registry mapping provider id ("openrouter", "ollama") to its client.
#[derive(Clone)]
pub struct ProviderRegistry {
    by_id: HashMap<String, ProviderArc>,
    default_id: Option<String>,
}

impl ProviderRegistry {
    pub fn from_configs(configs: &[ProviderConfig]) -> Self {
        let mut by_id: HashMap<String, ProviderArc> = HashMap::new();
        let mut default_id = None;
        for cfg in configs {
            let provider: ProviderArc = match cfg.kind {
                ProviderKind::OpenaiCompatible => {
                    Arc::new(openai_compatible::OpenAICompatibleProvider::new(cfg))
                }
                ProviderKind::CliClaude => Arc::new(cli_claude::CliClaudeProvider::new(cfg)),
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
                let mut configured: Vec<&str> =
                    self.by_id.keys().map(String::as_str).collect();
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
        let default = self
            .default_id
            .as_ref()
            .ok_or_else(|| "No providers configured. Set OPENROUTER_API_KEY in config.yaml.".to_string())?;
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

// Used by the openai_compatible impl for serializing messages.
pub(crate) fn chat_messages_to_openai(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| match m {
            ChatMessage::System { content } => serde_json::json!({
                "role": "system",
                "content": content,
            }),
            ChatMessage::User { content, images } => {
                if images.is_empty() {
                    serde_json::json!({ "role": "user", "content": content })
                } else {
                    let mut parts = vec![serde_json::json!({ "type": "text", "text": content })];
                    parts.extend(image_content_blocks(images));
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

/// Build OpenAI-style image content blocks from decoded images. Shared by the
/// plain OpenAI path and the Anthropic-caching path — both target an
/// OpenAI-compatible upstream (OpenRouter), so the image wire shape is the same
/// (`image_url` with a base64 data URL); only `cache_control` markers differ.
pub(crate) fn image_content_blocks(images: &[ImageData]) -> Vec<Value> {
    images
        .iter()
        .map(|img| {
            serde_json::json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:{};base64,{}", img.mime_type, img.base64),
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openrouter_only() -> ProviderRegistry {
        ProviderRegistry::from_configs(&[ProviderConfig {
            id: "openrouter".into(),
            kind: ProviderKind::OpenaiCompatible,
            base_url: Some("https://openrouter.ai/api/v1".into()),
            api_key: "test".into(),
            command: None,
            oauth_token: None,
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
        assert!(err.contains("'anthropic'"), "error should name the wanted provider: {err}");
        assert!(err.contains("openrouter"), "error should list configured providers: {err}");
        assert!(err.contains("config.yaml"), "error should point at config.yaml: {err}");
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
