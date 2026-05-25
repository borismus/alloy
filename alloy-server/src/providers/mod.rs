//! Provider abstraction.
//!
//! Phase 1 only ships the `openai_compatible` kind (used for OpenRouter,
//! Ollama, and any other OpenAI-compatible upstream). Future kinds
//! (Anthropic native, Gemini native) plug in as additional impls.

pub mod openai_compatible;

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::{ProviderConfig, ProviderKind};
use crate::types::{ToolCall, ToolDefinition};

/// Incoming wire message from the SPA's /api/stream/start body — simple
/// user/assistant text. The tool loop builds richer internal messages
/// (`ChatMessage`) during execution.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WireMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
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
pub fn wire_to_chat(messages: &[WireMessage], system_prompt: Option<&str>) -> Vec<ChatMessage> {
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
            }),
            "assistant" => out.push(ChatMessage::Assistant {
                content: m.content.clone(),
                tool_calls: Vec::new(),
            }),
            "log" => {} // skip
            _ => out.push(ChatMessage::User {
                content: m.content.clone(),
            }),
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

    /// Does this provider+model support tool calling? Used by the streaming
    /// session to decide whether to include the `tools` array. Default is
    /// optimistic (yes); concrete impls override.
    fn supports_tools(&self, _model: &str) -> bool {
        true
    }
}

pub type ProviderArc = Arc<dyn Provider>;

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
    /// Resolution: if the first segment matches a known provider id, use it
    /// and pass the remainder upstream. Otherwise, route to the default
    /// provider with the full string verbatim (backward compat for configs
    /// that still use unprefixed model ids).
    pub fn resolve<'a>(&'a self, model: &'a str) -> Option<(ProviderArc, &'a str)> {
        if let Some((first, rest)) = model.split_once('/') {
            if let Some(p) = self.by_id.get(first) {
                return Some((p.clone(), rest));
            }
        }
        let default = self.default_id.as_ref()?;
        let p = self.by_id.get(default)?.clone();
        Some((p, model))
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
            ChatMessage::User { content } => serde_json::json!({
                "role": "user",
                "content": content,
            }),
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
