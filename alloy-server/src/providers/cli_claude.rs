//! Claude Code CLI provider.
//!
//! Shells out to the `claude` binary in non-interactive print mode (`claude -p`)
//! so calls bill against the user's Claude Pro/Max **subscription** instead of an
//! API key — there is no HTTP API that bills the subscription, so the CLI is the
//! only mechanism. Output is the CLI's `stream-json` NDJSON, which we parse back
//! into Alloy's streaming text + `StreamResult`.
//!
//! Tool parity via MCP: Claude Code runs its own agent loop and can't accept
//! Alloy's tool definitions, so we point it at Alloy's own MCP endpoint
//! (`/api/mcp`) and hard-disable its native host tools. Claude then calls
//! `mcp__alloy__*`, which dispatch through the same `ToolRegistry::execute` as
//! every other provider — identical tools, vault scoping, and side effects.
//! `supports_tools()` stays false (Alloy doesn't attach ToolDefinitions to the
//! cli request — Claude Code discovers them via MCP `tools/list`).
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
use crate::types::{ToolCall, ToolResult};

/// Claude Code's standard built-in tools, hard-disabled so the subscription
/// model acts ONLY through Alloy's MCP tools (`mcp__alloy__*`). We can't use
/// `--tools` to allow-list (it breaks MCP tool-calling when Claude defers tools
/// behind ToolSearch) and we can't use `--bare`/`CLAUDE_CODE_SIMPLE` (they
/// disable subscription auth) — so an explicit deny list is the only lever that
/// keeps real MCP tool execution working. This covers the stable built-in set;
/// in particular `Skill` is denied so the model uses Alloy's `use_skill` instead
/// of Claude Code's own skills (which can shell out via e.g. `run-applescript`).
/// A user's *custom* plugin tools aren't enumerable here and are left intact —
/// they're the user's own, and the host-access vectors (Bash/Read/Write/Skill)
/// are closed.
const DISALLOWED_NATIVE_TOOLS: &[&str] = &[
    "Bash", "BashOutput", "KillShell", "Read", "Edit", "Write", "MultiEdit", "NotebookEdit",
    "Glob", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite", "Skill", "SlashCommand",
    "ExitPlanMode",
];

/// Bound on Claude Code's internal agent loop, so a misbehaving turn can't spin.
const MAX_AGENT_TURNS: &str = "20";

/// Well-known absolute install locations for the `claude` binary, searched when
/// it isn't explicitly configured. A macOS app launched from Finder/Dock does
/// NOT inherit the user's shell PATH (it gets `/usr/bin:/bin:/usr/sbin:/sbin`),
/// so a bare `claude` — installed under Homebrew or the native installer — won't
/// be found. We resolve to an absolute path instead.
fn resolve_claude_binary(configured: Option<&str>) -> String {
    // 1. Explicit `CLAUDE_CODE_PATH` wins (even if it doesn't exist yet — respect
    //    the user's intent and let the spawn surface a clear error).
    if let Some(c) = configured.filter(|c| !c.is_empty()) {
        return c.to_string();
    }
    // 2. Search known install locations.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/claude".to_string(),       // Homebrew (Apple Silicon)
        "/usr/local/bin/claude".to_string(),          // Homebrew (Intel) / npm global
        format!("{home}/.claude/local/claude"),       // Claude Code native installer
        format!("{home}/.local/bin/claude"),
        format!("{home}/.bun/bin/claude"),
        format!("{home}/.npm-global/bin/claude"),
    ];
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    // 3. Fall back to a PATH lookup (works when Alloy is launched from a shell).
    "claude".to_string()
}

pub struct CliClaudeProvider {
    /// Path to (or name of) the `claude` binary.
    command: String,
    /// Optional `claude setup-token` value, injected as `CLAUDE_CODE_OAUTH_TOKEN`.
    oauth_token: Option<String>,
}

impl CliClaudeProvider {
    pub fn new(cfg: &ProviderConfig) -> Self {
        Self {
            command: resolve_claude_binary(cfg.command.as_deref()),
            oauth_token: cfg.oauth_token.clone().filter(|t| !t.is_empty()),
        }
    }

    /// Base command shared by streaming and one-shot calls: print mode, no MCP,
    /// neutral settings, subscription auth. The caller adds tool flags (an empty
    /// set for one-shot completions, the allow-list for streaming chat).
    fn base_command(&self, model: &str) -> Command {
        let mut cmd = Command::new(&self.command);
        cmd.arg("-p")
            .arg("--model")
            .arg(model)
            .arg("--permission-mode")
            .arg("default")
            // Ignore the user's own MCP servers; each caller supplies its own
            // `--mcp-config` (none for one-shots, Alloy's bridge for streaming).
            .arg("--strict-mcp-config")
            // Only load ~/.claude settings, not project/local ones.
            .arg("--setting-sources")
            .arg("user");
        // Run from a neutral dir so the child can't pick up a project CLAUDE.md
        // / .claude (e.g. Alloy's own repo) as implicit context. Streaming
        // overrides this to the vault so read tools resolve there.
        cmd.current_dir(std::env::temp_dir());
        // Prepend the common CLI install dirs to PATH so the child (and anything
        // it shells out to) is found even when Alloy was launched from Finder/Dock
        // with a minimal PATH.
        let home = std::env::var("HOME").unwrap_or_default();
        let existing = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{existing}"),
        );
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
        // One-shot completions never use tools (no MCP servers, empty tool set).
        cmd.arg("--mcp-config").arg(r#"{"mcpServers":{}}"#);
        cmd.arg("--tools").arg("");
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
            .arg("--verbose")
            .arg("--max-turns")
            .arg(MAX_AGENT_TURNS);
        // Tool parity: route tool calls through Alloy's MCP bridge (our built-in
        // tools), and hard-disable Claude Code's native host tools so the model
        // can only act through Alloy. Without an MCP bridge (server URL unknown),
        // the model runs text-only — never with native host tools.
        // Disable Claude Code's standard built-in tools so the model acts only
        // through Alloy's MCP tools. (Leaves ToolSearch + any plugin tools, which
        // Claude Code uses to surface deferred MCP tools — disabling those breaks
        // MCP tool-calling.)
        cmd.arg("--disallowedTools").args(DISALLOWED_NATIVE_TOOLS);
        if let Some(mcp) = &req.mcp {
            let url = format!(
                "{}/api/mcp?session={}&token={}",
                mcp.base_url, mcp.session_id, mcp.token
            );
            let cfg = json!({ "mcpServers": { "alloy": { "type": "http", "url": url } } });
            cmd.arg("--mcp-config").arg(cfg.to_string());
            cmd.arg("--allowedTools").arg("mcp__alloy__*");
        } else {
            cmd.arg("--mcp-config").arg(r#"{"mcpServers":{}}"#);
        }
        if let Some(sys) = system.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--system-prompt").arg(sys);
        }

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "failed to launch the `claude` CLI at `{}`: {}. Install Claude Code, or set \
                 `CLAUDE_CODE_PATH` in config.yaml to its absolute path (e.g. \
                 /opt/homebrew/bin/claude) — a Finder-launched app doesn't inherit your shell PATH.",
                self.command, e
            )
        })?;

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
        // Assistant message snapshots repeat already-seen tool_use blocks; only
        // surface each tool call once.
        let mut seen_tool_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

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
                                // Claude Code runs its tool loop internally; surface
                                // its tool calls/results as Alloy pills via the sink.
                                Some("assistant") => {
                                    for call in extract_tool_uses(&v) {
                                        if seen_tool_ids.insert(call.id.clone()) {
                                            req.tool_sink.on_tool_use(&call);
                                        }
                                    }
                                }
                                Some("user") => {
                                    for result in extract_tool_results(&v) {
                                        req.tool_sink.on_tool_result(&result);
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

/// Pull `tool_use` content blocks out of a full `assistant` message snapshot.
fn extract_tool_uses(v: &Value) -> Vec<ToolCall> {
    message_content_blocks(v)
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|b| {
            Some(ToolCall {
                id: b.get("id").and_then(Value::as_str)?.to_string(),
                name: b.get("name").and_then(Value::as_str)?.to_string(),
                input: b.get("input").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect()
}

/// Pull `tool_result` content blocks out of a `user` message (the tool results
/// Claude Code fed back into its own loop).
fn extract_tool_results(v: &Value) -> Vec<ToolResult> {
    message_content_blocks(v)
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|b| {
            Some(ToolResult {
                tool_use_id: b.get("tool_use_id").and_then(Value::as_str)?.to_string(),
                content: tool_result_text(b.get("content")),
                is_error: b.get("is_error").and_then(Value::as_bool),
            })
        })
        .collect()
}

/// `message.content` array of a wrapped CLI message, or empty.
fn message_content_blocks(v: &Value) -> Vec<Value> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// A `tool_result` block's `content` is either a string or an array of text
/// blocks; normalize to a plain string.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
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
    fn extracts_tool_use_from_assistant_message() {
        let v = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"let me check"},
            {"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/v/note.md"}}
        ]}});
        let calls = extract_tool_uses(&v);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].name, "Read");
        assert_eq!(calls[0].input["file_path"], "/v/note.md");
    }

    #[test]
    fn extracts_tool_result_string_and_array_and_error() {
        let str_form = json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"toolu_1","content":"hello"}
        ]}});
        let r = extract_tool_results(&str_form);
        assert_eq!(r[0].tool_use_id, "toolu_1");
        assert_eq!(r[0].content, "hello");
        assert_eq!(r[0].is_error, None);

        let arr_form = json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"t2","is_error":true,
             "content":[{"type":"text","text":"line1"},{"type":"text","text":"line2"}]}
        ]}});
        let r = extract_tool_results(&arr_form);
        assert_eq!(r[0].content, "line1\nline2");
        assert_eq!(r[0].is_error, Some(true));
    }

    #[test]
    fn disallowed_native_tools_cover_the_dangerous_set() {
        // Regression guard: `Skill` must stay denied so the model uses Alloy's
        // `use_skill` over Claude Code's own skills (which can shell out). Same
        // for the host-access tools.
        for t in ["Skill", "Bash", "Read", "Write", "Edit", "WebSearch"] {
            assert!(
                DISALLOWED_NATIVE_TOOLS.contains(&t),
                "{t} must be in the native-tool denylist"
            );
        }
    }

    #[test]
    fn resolve_claude_binary_prefers_explicit_config() {
        assert_eq!(
            resolve_claude_binary(Some("/custom/claude")),
            "/custom/claude"
        );
        // Empty config is ignored (falls through to discovery/PATH).
        assert_ne!(resolve_claude_binary(Some("")), "");
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
