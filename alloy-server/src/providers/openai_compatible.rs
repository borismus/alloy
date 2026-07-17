//! OpenAI-compatible streaming chat client.
//!
//! Talks to any provider that exposes `POST /chat/completions` with the
//! standard OpenAI request/response/SSE shape. Tested against OpenRouter
//! and Ollama in Phase 1.

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::ProviderConfig;
use crate::providers::{
    ChatMessage, Provider, StreamRequest, StreamResult, Usage, chat_messages_to_openai,
    image_content_blocks,
};
use crate::types::{ToolCall, to_openai_tools};

pub struct OpenAICompatibleProvider {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl OpenAICompatibleProvider {
    pub fn new(cfg: &ProviderConfig) -> Self {
        let base = cfg
            .base_url
            .clone()
            .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string());
        Self {
            base_url: base.trim_end_matches('/').to_string(),
            api_key: cfg.api_key.clone(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()
                .expect("reqwest client"),
        }
    }

    fn chat_url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Issue an authenticated POST to /chat/completions with optional
    /// OpenRouter analytics headers.
    fn post_chat(&self, body: Value) -> reqwest::RequestBuilder {
        let mut builder = self
            .http
            .post(self.chat_url())
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json");
        if self.base_url.contains("openrouter.ai") {
            builder = builder
                .header("HTTP-Referer", "https://github.com/borismus/alloy")
                .header("X-Title", "Alloy");
        }
        builder.json(&body)
    }
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    choices: Vec<ChoiceDelta>,
    #[serde(default)]
    usage: Option<UsageDelta>,
}

#[derive(Deserialize, Default)]
struct ChoiceDelta {
    #[serde(default)]
    delta: DeltaContent,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct DeltaContent {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize, Default)]
struct UsageDelta {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
}

/// Accumulator for streaming tool calls. OpenAI delivers `tool_calls` deltas
/// indexed by position; we concat `arguments` until the stream ends.
#[derive(Default)]
struct ToolCallBuf {
    id: String,
    name: String,
    arguments: String,
}

#[async_trait]
impl Provider for OpenAICompatibleProvider {
    async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
        let messages = if is_anthropic_model(&req.model) {
            // Anthropic via OpenRouter supports prompt caching via per-block
            // `cache_control` markers. We cache the system prompt and the
            // second-to-last user message so multi-turn replays hit the cache.
            apply_anthropic_caching(&req.messages)
        } else {
            chat_messages_to_openai(&req.messages)
        };

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "max_tokens": 8192,
            "stream_options": { "include_usage": true },
        });
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(to_openai_tools(&req.tools));
        }

        let response = self.post_chat(body).send().await?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("upstream {} returned {}: {}", self.base_url, status, text);
        }

        let mut full_response = String::new();
        let mut response_id: Option<String> = None;
        let mut input_tokens: u32 = 0;
        let mut output_tokens: u32 = 0;
        let mut stop_reason = "end_turn".to_string();

        let mut tool_buf: Vec<ToolCallBuf> = Vec::new();

        let mut stream = response.bytes_stream().eventsource();
        while let Some(event) = stream.next().await {
            if *req.cancel.borrow() {
                break;
            }
            let event = match event {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("SSE parse error: {}", e);
                    continue;
                }
            };
            let data = event.data;
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let chunk: StreamChunk = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("SSE JSON parse error: {} (data: {})", e, data);
                    continue;
                }
            };

            if let Some(id) = chunk.id {
                if response_id.is_none() {
                    response_id = Some(id);
                }
            }
            if let Some(usage) = chunk.usage {
                if let Some(p) = usage.prompt_tokens {
                    input_tokens = p;
                }
                if let Some(c) = usage.completion_tokens {
                    output_tokens = c;
                }
            }

            for choice in chunk.choices {
                if let Some(fr) = choice.finish_reason {
                    stop_reason = match fr.as_str() {
                        "stop" => "end_turn".into(),
                        "length" => "max_tokens".into(),
                        "tool_calls" => "tool_use".into(),
                        other => other.to_string(),
                    };
                }
                if let Some(text) = choice.delta.content {
                    if !text.is_empty() {
                        full_response.push_str(&text);
                        let _ = req.chunk_tx.send(text);
                    }
                }
                for tc_delta in choice.delta.tool_calls {
                    let idx = tc_delta.index.unwrap_or(0);
                    while tool_buf.len() <= idx {
                        tool_buf.push(ToolCallBuf::default());
                    }
                    let slot = &mut tool_buf[idx];
                    if let Some(id) = tc_delta.id {
                        slot.id = id;
                    }
                    if let Some(func) = tc_delta.function {
                        if let Some(name) = func.name {
                            slot.name = name;
                        }
                        if let Some(args) = func.arguments {
                            slot.arguments.push_str(&args);
                        }
                    }
                }
            }
        }

        // Finalize tool calls — parse the accumulated arguments JSON.
        let mut tool_calls = Vec::new();
        for buf in tool_buf {
            if buf.id.is_empty() || buf.name.is_empty() {
                continue;
            }
            let input: Value = if buf.arguments.is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str(&buf.arguments).unwrap_or_else(|e| {
                    tracing::warn!(
                        "tool arguments JSON parse failed for {}: {} (raw: {})",
                        buf.name,
                        e,
                        buf.arguments
                    );
                    Value::Object(serde_json::Map::new())
                })
            };
            tool_calls.push(ToolCall {
                id: buf.id,
                name: buf.name,
                input,
            });
        }
        // If the model emitted tool calls, normalize stop reason.
        if !tool_calls.is_empty() && stop_reason != "tool_use" {
            stop_reason = "tool_use".into();
        }

        let usage = if input_tokens > 0 || output_tokens > 0 {
            Some(Usage {
                input_tokens,
                output_tokens,
                response_id,
                cost: None,
                duration_ms: None,
            })
        } else {
            None
        };

        Ok(StreamResult {
            content: full_response,
            usage,
            stop_reason,
            tool_calls,
        })
    }

    async fn generate_title(&self, user_msg: &str, assistant_msg: &str, model: &str) -> String {
        let prompt = format!(
            "Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: {}\n\nAssistant: {}",
            &user_msg.chars().take(500).collect::<String>(),
            &assistant_msg.chars().take(500).collect::<String>()
        );

        #[derive(Serialize)]
        struct TitleReq<'a> {
            model: &'a str,
            messages: Vec<TitleMsg<'a>>,
            max_tokens: u32,
        }
        #[derive(Serialize)]
        struct TitleMsg<'a> {
            role: &'a str,
            content: &'a str,
        }

        let body = serde_json::to_value(&TitleReq {
            model,
            messages: vec![TitleMsg {
                role: "user",
                content: &prompt,
            }],
            max_tokens: 50,
        })
        .unwrap();

        let response = match self.post_chat(body).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                tracing::warn!(
                    "title generation HTTP {}: {}",
                    r.status(),
                    r.text().await.unwrap_or_default()
                );
                return fallback_title(user_msg);
            }
            Err(e) => {
                tracing::warn!("title generation request failed: {}", e);
                return fallback_title(user_msg);
            }
        };

        let body: Value = match response.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("title generation JSON parse failed: {}", e);
                return fallback_title(user_msg);
            }
        };

        let text = body
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim();

        if text.is_empty() {
            fallback_title(user_msg)
        } else {
            text.chars().take(100).collect()
        }
    }

    async fn complete_once(
        &self,
        system: &str,
        user: &str,
        model: &str,
        max_tokens: u32,
    ) -> Option<String> {
        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": max_tokens,
        });

        let response = match self.post_chat(body).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                tracing::warn!(
                    "complete_once HTTP {}: {}",
                    r.status(),
                    r.text().await.unwrap_or_default()
                );
                return None;
            }
            Err(e) => {
                tracing::warn!("complete_once request failed: {}", e);
                return None;
            }
        };

        let body: Value = match response.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("complete_once JSON parse failed: {}", e);
                return None;
            }
        };

        let text = body
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim();

        if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    }

    /// Heuristic: most cloud models on OpenRouter support tool calling. Ollama
    /// support varies by model — we'd need to call /api/show. For Phase 1 we
    /// assume yes and let upstream errors surface if a model can't handle it.
    fn supports_tools(&self, _model: &str) -> bool {
        true
    }
}

fn fallback_title(user_msg: &str) -> String {
    user_msg.chars().take(50).collect()
}

/// True if the model id routes to an Anthropic upstream (so prompt-caching
/// markers apply). Covers both bare ("anthropic/claude-...") and provider-
/// prefixed ("openrouter/anthropic/claude-...") shapes.
fn is_anthropic_model(model: &str) -> bool {
    model.contains("anthropic/") || model.starts_with("claude-")
}

/// Build OpenAI-style messages for an Anthropic-targeted request, with
/// per-block `cache_control: { type: "ephemeral" }` markers on the system
/// prompt and the second-to-last user turn (matches the SPA-side pattern in
/// [src/services/providers/anthropic.ts:35-55](src/services/providers/anthropic.ts#L35-L55)).
fn apply_anthropic_caching(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    // Find user-message indices in the post-cache wire format.
    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| matches!(m, ChatMessage::User { .. }).then_some(i))
        .collect();
    let cache_target_user_idx = if user_indices.len() >= 2 {
        Some(user_indices[user_indices.len() - 2])
    } else {
        None
    };

    messages
        .iter()
        .enumerate()
        .map(|(i, m)| match m {
            ChatMessage::System { content } => json!({
                "role": "system",
                "content": [{
                    "type": "text",
                    "text": content,
                    "cache_control": { "type": "ephemeral" },
                }],
            }),
            ChatMessage::User { content, images } => {
                let cache = Some(i) == cache_target_user_idx;
                let mut block = serde_json::Map::new();
                block.insert("type".into(), json!("text"));
                block.insert("text".into(), json!(content));
                if cache {
                    block.insert("cache_control".into(), json!({ "type": "ephemeral" }));
                }
                // Text block stays at content[0] so cache_control always lands
                // on it; image blocks follow.
                let mut parts = vec![serde_json::Value::Object(block)];
                parts.extend(image_content_blocks(images));
                json!({
                    "role": "user",
                    "content": parts,
                })
            }
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                let mut obj = serde_json::Map::new();
                obj.insert("role".into(), json!("assistant"));
                if content.is_empty() && !tool_calls.is_empty() {
                    obj.insert("content".into(), serde_json::Value::Null);
                } else {
                    obj.insert("content".into(), json!(content));
                }
                if !tool_calls.is_empty() {
                    obj.insert(
                        "tool_calls".into(),
                        serde_json::to_value(tool_calls).unwrap_or(serde_json::Value::Null),
                    );
                }
                serde_json::Value::Object(obj)
            }
            ChatMessage::Tool {
                tool_call_id,
                content,
            } => json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content,
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_anthropic_models() {
        assert!(is_anthropic_model("openrouter/anthropic/claude-sonnet-4.6"));
        assert!(is_anthropic_model("anthropic/claude-haiku-4-5"));
        assert!(is_anthropic_model("claude-opus-4-7"));
        assert!(!is_anthropic_model("openai/gpt-5.5"));
        assert!(!is_anthropic_model("openrouter/google/gemini-3.5-flash"));
    }

    #[test]
    fn caches_only_second_to_last_user_turn() {
        let msgs = vec![
            ChatMessage::System { content: "sys".into() },
            ChatMessage::User { content: "u1".into(), images: vec![] },
            ChatMessage::Assistant { content: "a1".into(), tool_calls: vec![] },
            ChatMessage::User { content: "u2".into(), images: vec![] },
            ChatMessage::Assistant { content: "a2".into(), tool_calls: vec![] },
            ChatMessage::User { content: "u3".into(), images: vec![] },
        ];
        let wire = apply_anthropic_caching(&msgs);
        // System always cached.
        let sys = &wire[0]["content"][0];
        assert_eq!(sys["cache_control"]["type"], "ephemeral");
        // u2 is second-to-last user → cached.
        let u2 = &wire[3]["content"][0];
        assert_eq!(u2["cache_control"]["type"], "ephemeral");
        // u1 not cached.
        let u1 = &wire[1]["content"][0];
        assert!(u1.get("cache_control").is_none());
        // u3 (latest) not cached.
        let u3 = &wire[5]["content"][0];
        assert!(u3.get("cache_control").is_none());
    }

    #[test]
    fn single_user_message_only_caches_system() {
        let msgs = vec![
            ChatMessage::System { content: "sys".into() },
            ChatMessage::User { content: "u1".into(), images: vec![] },
        ];
        let wire = apply_anthropic_caching(&msgs);
        let sys = &wire[0]["content"][0];
        assert_eq!(sys["cache_control"]["type"], "ephemeral");
        let u1 = &wire[1]["content"][0];
        assert!(u1.get("cache_control").is_none());
    }

    #[test]
    fn appends_image_blocks_after_cached_text() {
        use crate::providers::ImageData;
        let msgs = vec![
            ChatMessage::System { content: "sys".into() },
            ChatMessage::User {
                content: "u1".into(),
                images: vec![ImageData {
                    mime_type: "image/png".into(),
                    base64: "AAAA".into(),
                }],
            },
        ];
        let wire = apply_anthropic_caching(&msgs);
        let content = &wire[1]["content"];
        // Text block stays first so cache_control can land on it; image follows.
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }
}
