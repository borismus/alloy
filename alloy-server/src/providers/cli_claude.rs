//! Claude Code CLI provider.
//!
//! Shells out to the `claude` binary in non-interactive print mode (`claude -p`)
//! so calls bill against the user's Claude Pro/Max **subscription** instead of an
//! API key — there is no HTTP API that bills the subscription, so the CLI is the
//! only mechanism. Output is the CLI's `stream-json` NDJSON, which we parse back
//! into Alloy's streaming text + `StreamResult`.
//!
//! Text-only by design: Claude Code is an agent with its own tools that act on
//! the host filesystem and cannot accept Alloy's tool definitions, so we disable
//! its tools (`--tools ""`) and report `supports_tools() == false`. The tool loop
//! above the provider then skips tool wiring entirely.
//!
//! Auth: with `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` present, Claude Code
//! silently switches to API billing — so we scrub both from the child env. A
//! configured `oauth_token` (`claude setup-token`) is injected as
//! `CLAUDE_CODE_OAUTH_TOKEN`; otherwise we rely on the host's `claude` login.

use std::process::Stdio;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::config::ProviderConfig;
use crate::providers::{ChatMessage, ImageData, Provider, StreamRequest, StreamResult, Usage};

pub struct CliClaudeProvider {
    /// Path to (or name of) the `claude` binary.
    command: String,
    /// Optional `claude setup-token` value, injected as `CLAUDE_CODE_OAUTH_TOKEN`.
    oauth_token: Option<String>,
}

impl CliClaudeProvider {
    pub fn new(cfg: &ProviderConfig) -> Self {
        Self {
            command: cfg.command.clone().unwrap_or_else(|| "claude".to_string()),
            oauth_token: cfg.oauth_token.clone().filter(|t| !t.is_empty()),
        }
    }

    /// Base command shared by streaming and one-shot calls: print mode, no
    /// tools, no MCP, neutral settings, subscription auth.
    fn base_command(&self, model: &str) -> Command {
        let mut cmd = Command::new(&self.command);
        cmd.arg("-p")
            .arg("--model")
            .arg(model)
            // Text-only: empty allowed-tool set (verified to yield `tools: []`).
            .arg("--tools")
            .arg("")
            .arg("--permission-mode")
            .arg("default")
            // No MCP servers, ignore any other MCP config sources.
            .arg("--strict-mcp-config")
            .arg("--mcp-config")
            .arg(r#"{"mcpServers":{}}"#)
            // Only load ~/.claude settings, not project/local ones.
            .arg("--setting-sources")
            .arg("user");
        // Run from a neutral dir so the child can't pick up a project CLAUDE.md
        // / .claude (e.g. Alloy's own repo) as implicit context.
        cmd.current_dir(std::env::temp_dir());
        // Force subscription billing: scrub API-key auth, optionally inject the
        // subscription OAuth token.
        cmd.env_remove("ANTHROPIC_API_KEY");
        cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        if let Some(token) = &self.oauth_token {
            cmd.env("CLAUDE_CODE_OAUTH_TOKEN", token);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// One-shot, non-streaming completion via `--output-format json`. Returns
    /// the `result` text, or `None` on any failure (matches the `complete_once`
    /// fallback contract; also used by title generation).
    async fn run_once(&self, system: Option<&str>, user: &str, model: &str) -> Option<String> {
        let mut cmd = self.base_command(model);
        cmd.arg("--output-format").arg("json");
        if let Some(sys) = system.filter(|s| !s.is_empty()) {
            cmd.arg("--system-prompt").arg(sys);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("claude CLI spawn failed ({}): {}", self.command, e);
                return None;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(user.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        let output = match child.wait_with_output().await {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!("claude CLI wait failed: {}", e);
                return None;
            }
        };
        if !output.status.success() {
            tracing::warn!(
                "claude CLI exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return None;
        }
        let parsed: Value = serde_json::from_slice(&output.stdout).ok()?;
        let text = parsed.get("result").and_then(Value::as_str).unwrap_or("").trim();
        (!text.is_empty()).then(|| text.to_string())
    }
}

#[async_trait]
impl Provider for CliClaudeProvider {
    async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
        let (system, user_text, images) = flatten_conversation(&req.messages);

        let mut cmd = self.base_command(&req.model);
        cmd.arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose");
        if let Some(sys) = system.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--system-prompt").arg(sys);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to launch `{}` (is Claude Code installed and on PATH?): {}", self.command, e))?;

        // Feed the single synthesized user message, then close stdin so the CLI
        // produces one response and exits.
        let input = json!({
            "type": "user",
            "message": { "role": "user", "content": user_message_content(&user_text, &images) },
        });
        if let Some(mut stdin) = child.stdin.take() {
            let line = format!("{}\n", input);
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }

        // Drain stderr concurrently so a chatty child can't deadlock on a full
        // pipe; collected at the end and surfaced only if the run fails.
        let stderr_handle = child.stderr.take().map(|mut stderr| {
            tokio::spawn(async move {
                let mut buf = String::new();
                let _ = stderr.read_to_string(&mut buf).await;
                buf
            })
        });

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("claude CLI produced no stdout"))?;
        let mut lines = BufReader::new(stdout).lines();

        let mut content = String::new();
        let mut result_text: Option<String> = None;
        let mut stop_reason = "end_turn".to_string();
        let mut input_tokens: u32 = 0;
        let mut output_tokens: u32 = 0;
        let mut error_msg: Option<String> = None;

        let mut cancel = req.cancel;
        if *cancel.borrow() {
            let _ = child.start_kill();
        }

        loop {
            tokio::select! {
                line = lines.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            if line.trim().is_empty() { continue; }
                            let Ok(v): Result<Value, _> = serde_json::from_str(&line) else { continue };
                            match v.get("type").and_then(Value::as_str) {
                                Some("stream_event") => {
                                    if let Some(text) = partial_text_delta(&v) {
                                        content.push_str(text);
                                        let _ = req.chunk_tx.send(text.to_string());
                                    }
                                }
                                Some("result") => {
                                    if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                                        error_msg = Some(
                                            v.get("result").and_then(Value::as_str)
                                                .unwrap_or("claude CLI reported an error")
                                                .to_string(),
                                        );
                                    }
                                    if let Some(t) = v.get("result").and_then(Value::as_str) {
                                        result_text = Some(t.to_string());
                                    }
                                    if let Some(sr) = v.get("stop_reason").and_then(Value::as_str) {
                                        if !sr.is_empty() { stop_reason = sr.to_string(); }
                                    }
                                    if let Some(u) = v.get("usage") {
                                        input_tokens = u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0) as u32
                                            + u.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0) as u32
                                            + u.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
                                        output_tokens = u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
                                    }
                                }
                                _ => {}
                            }
                        }
                        Ok(None) => break,
                        Err(e) => { tracing::warn!("claude CLI stdout read error: {}", e); break; }
                    }
                }
                _ = cancel.changed() => {
                    if *cancel.borrow() {
                        let _ = child.start_kill();
                        break;
                    }
                }
            }
        }

        let status = child.wait().await.ok();
        let cancelled = *cancel.borrow();

        // Final content: prefer the authoritative `result` text; if we never
        // streamed it (no partials), emit it now so the UI isn't left empty.
        if content.is_empty() {
            if let Some(t) = &result_text {
                if !t.is_empty() {
                    content = t.clone();
                    let _ = req.chunk_tx.send(t.clone());
                }
            }
        }

        if let Some(msg) = error_msg {
            anyhow::bail!("claude CLI: {}", msg);
        }
        if !cancelled && content.is_empty() {
            let failed = status.map(|s| !s.success()).unwrap_or(true);
            if failed {
                let stderr_buf = match stderr_handle {
                    Some(h) => h.await.unwrap_or_default(),
                    None => String::new(),
                };
                let stderr = stderr_buf.trim();
                let hint = if stderr.is_empty() {
                    "no output (is `claude` logged in to a Claude subscription? run `claude` once to log in, or set oauth_token)".to_string()
                } else {
                    stderr.to_string()
                };
                anyhow::bail!("claude CLI produced no response: {}", hint);
            }
        }

        let usage = if input_tokens > 0 || output_tokens > 0 {
            Some(Usage {
                input_tokens,
                output_tokens,
                response_id: None,
                cost: None, // subscription billing — no per-token cost shown
            })
        } else {
            None
        };

        Ok(StreamResult {
            content,
            usage,
            stop_reason,
            tool_calls: Vec::new(),
        })
    }

    async fn generate_title(&self, user_msg: &str, assistant_msg: &str, model: &str) -> String {
        let prompt = format!(
            "Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: {}\n\nAssistant: {}",
            user_msg.chars().take(500).collect::<String>(),
            assistant_msg.chars().take(500).collect::<String>(),
        );
        match self.run_once(None, &prompt, model).await {
            Some(t) => t.chars().take(100).collect(),
            None => user_msg.chars().take(50).collect(),
        }
    }

    async fn complete_once(
        &self,
        system: &str,
        user: &str,
        model: &str,
        _max_tokens: u32,
    ) -> Option<String> {
        self.run_once(Some(system), user, model).await
    }

    /// Text-only: Claude Code can't accept Alloy's tool definitions, so the tool
    /// loop must not attach tools for this provider.
    fn supports_tools(&self, _model: &str) -> bool {
        false
    }
}

/// Pull the system prompt out, flatten the remaining turns into one transcript
/// string, and collect images from the latest user turn. `--input-format
/// stream-json` only accepts user messages, so prior assistant turns are
/// rendered as labeled text rather than true assistant-role messages.
fn flatten_conversation(messages: &[ChatMessage]) -> (Option<String>, String, Vec<ImageData>) {
    let mut system = None;
    let mut turns: Vec<&ChatMessage> = Vec::new();
    for m in messages {
        match m {
            ChatMessage::System { content } => system = Some(content.clone()),
            // Tool turns can't occur (we never send tools), but skip defensively.
            ChatMessage::Tool { .. } => {}
            other => turns.push(other),
        }
    }

    let latest_images = turns
        .iter()
        .rev()
        .find_map(|m| match m {
            ChatMessage::User { images, .. } if !images.is_empty() => Some(images.clone()),
            _ => None,
        })
        .unwrap_or_default();

    // Single user turn: pass its text verbatim. Multi-turn: a labeled transcript
    // that ends on the latest user message.
    let text = if turns.len() == 1 {
        match turns[0] {
            ChatMessage::User { content, .. } => content.clone(),
            _ => String::new(),
        }
    } else {
        turns
            .iter()
            .filter_map(|m| match m {
                ChatMessage::User { content, .. } => Some(format!("User: {}", content)),
                ChatMessage::Assistant { content, .. } if !content.is_empty() => {
                    Some(format!("Assistant: {}", content))
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    (system, text, latest_images)
}

/// Build the `content` array for a stream-json user message: a text block plus
/// any base64 image blocks (Anthropic content-block shape).
fn user_message_content(text: &str, images: &[ImageData]) -> Value {
    let mut parts = vec![json!({ "type": "text", "text": text })];
    for img in images {
        parts.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.mime_type, "data": img.base64 },
        }));
    }
    Value::Array(parts)
}

/// Extract incremental visible text from a wrapped `stream_event`. Returns
/// `Some(text)` only for `content_block_delta` → `text_delta`; thinking and
/// signature deltas are intentionally skipped (not part of the answer).
fn partial_text_delta(v: &Value) -> Option<&str> {
    let event = v.get("event")?;
    if event.get("type").and_then(Value::as_str)? != "content_block_delta" {
        return None;
    }
    let delta = event.get("delta")?;
    if delta.get("type").and_then(Value::as_str)? != "text_delta" {
        return None;
    }
    delta.get("text").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> ChatMessage {
        ChatMessage::User { content: content.into(), images: vec![] }
    }
    fn assistant(content: &str) -> ChatMessage {
        ChatMessage::Assistant { content: content.into(), tool_calls: vec![] }
    }

    #[test]
    fn single_turn_passes_text_verbatim() {
        let msgs = vec![
            ChatMessage::System { content: "be brief".into() },
            user("what is 2+2?"),
        ];
        let (system, text, images) = flatten_conversation(&msgs);
        assert_eq!(system.as_deref(), Some("be brief"));
        assert_eq!(text, "what is 2+2?");
        assert!(images.is_empty());
    }

    #[test]
    fn multi_turn_builds_labeled_transcript() {
        let msgs = vec![
            ChatMessage::System { content: "sys".into() },
            user("hi"),
            assistant("hello!"),
            user("how are you?"),
        ];
        let (_, text, _) = flatten_conversation(&msgs);
        assert_eq!(text, "User: hi\n\nAssistant: hello!\n\nUser: how are you?");
    }

    #[test]
    fn collects_images_from_latest_user_turn() {
        let img = ImageData { mime_type: "image/png".into(), base64: "AAAA".into() };
        let msgs = vec![
            user("first"),
            assistant("ok"),
            ChatMessage::User { content: "look".into(), images: vec![img] },
        ];
        let (_, _, images) = flatten_conversation(&msgs);
        assert_eq!(images.len(), 1);
        let content = user_message_content("look", &images);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "AAAA");
    }

    #[test]
    fn partial_text_delta_extracts_only_text_deltas() {
        let text = json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello world"}}});
        assert_eq!(partial_text_delta(&text), Some("hello world"));
        let thinking = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}});
        assert_eq!(partial_text_delta(&thinking), None);
        let start = json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}});
        assert_eq!(partial_text_delta(&start), None);
    }
}
