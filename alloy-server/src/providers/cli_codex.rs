//! Codex CLI provider (OpenAI Codex, ChatGPT/Codex subscription).
//!
//! Shells out to `codex exec` in a read-only sandbox so calls bill against the
//! user's ChatGPT/Codex **subscription** (via `codex login`) rather than an API
//! key. Text-only: Codex runs its own agent loop; Alloy doesn't attach tool
//! definitions or bridge MCP (unlike cli_claude), so the model just answers.
//! Prompts go to OpenAI, so this provider is always CLOUD (never `local`, no
//! private-dir access — enforced in `local::provider_is_local`).
//!
//! Verified against codex-cli 0.145.0 (`stored auth mode: chatgpt`):
//!   * the prompt is fed on **stdin** (no positional arg);
//!   * `--output-last-message <file>` writes just the final agent message;
//!   * `--json` emits JSONL: `{"type":"item.completed","item":{"type":
//!     "agent_message","text":...}}` for the answer and
//!     `{"type":"turn.completed","usage":{"input_tokens":..,"output_tokens":..}}`
//!     for token counts; failures arrive as `{"type":"error"|"turn.failed",..}`;
//!   * a **ChatGPT account only accepts the server-default model** — passing an
//!     unsupported `--model` (e.g. `gpt-5-codex`) fails the turn — so we omit
//!     `--model` unless the caller explicitly picks a non-"default" model.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::ProviderConfig;
use crate::providers::{
    ChatMessage, Provider, ProviderStreamEvent, StreamRequest, StreamResult, Usage,
};

/// Well-known absolute install locations for the `codex` binary (a Finder-
/// launched macOS app doesn't inherit the shell PATH).
fn resolve_codex_binary(configured: Option<&str>) -> String {
    if let Some(c) = configured.filter(|c| !c.is_empty()) {
        return c.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/codex".to_string(),
        "/usr/local/bin/codex".to_string(),
        format!("{home}/.local/bin/codex"),
        format!("{home}/.bun/bin/codex"),
        format!("{home}/.npm-global/bin/codex"),
        format!("{home}/.cargo/bin/codex"),
    ];
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    "codex".to_string()
}

/// Unique temp path for `--output-last-message` so concurrent turns don't clash.
fn last_message_path() -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("alloy-codex-{}-{nanos}-{n}.txt", std::process::id()))
}

pub struct CliCodexProvider {
    command: String,
}

struct RunOutput {
    text: String,
    usage: Option<Usage>,
}

impl CliCodexProvider {
    pub fn new(cfg: &ProviderConfig) -> Self {
        Self {
            command: resolve_codex_binary(cfg.command.as_deref()),
        }
    }

    fn base_command(&self, model: &str, out_file: &Path) -> Command {
        let mut cmd = Command::new(&self.command);
        cmd.arg("exec");
        // A ChatGPT-account codex only accepts the server-default model; passing
        // a model it doesn't allow fails the turn. So only send `--model` for an
        // explicit, non-default pick (e.g. an account/plan that supports it).
        if !model.is_empty() && model != "default" {
            cmd.arg("--model").arg(model);
        }
        cmd.arg("--sandbox")
            .arg("read-only")
            .arg("--skip-git-repo-check")
            .arg("--json")
            .arg("--output-last-message")
            .arg(out_file);
        cmd.current_dir(std::env::temp_dir());
        let home = std::env::var("HOME").unwrap_or_default();
        let existing = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{existing}"),
        );
        // Force subscription billing: an API key would switch codex to API
        // billing, so scrub it (mirrors cli_claude scrubbing ANTHROPIC_API_KEY).
        cmd.env_remove("OPENAI_API_KEY");
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// Run `codex exec` with `prompt` on stdin; return the final agent message
    /// (+ token usage).
    async fn run(&self, prompt: &str, model: &str) -> anyhow::Result<RunOutput> {
        let out_file = last_message_path();
        let mut cmd = self.base_command(model, &out_file);
        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "failed to launch the `codex` CLI at `{}`: {}. Install the OpenAI Codex CLI and run \
                 `codex login`, or set the provider's `command` to its absolute path.",
                self.command, e
            )
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        let output = child
            .wait_with_output()
            .await
            .map_err(|e| anyhow::anyhow!("codex CLI wait failed: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let events = parse_events(&stdout);

        // A failed turn (e.g. an unsupported model on a ChatGPT account) surfaces
        // as an `error` / `turn.failed` event regardless of exit code.
        if let Some(err) = events.error {
            let _ = std::fs::remove_file(&out_file);
            anyhow::bail!("codex CLI error: {err}");
        }
        if !output.status.success() {
            let _ = std::fs::remove_file(&out_file);
            anyhow::bail!(
                "codex CLI exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        // Prefer the clean --output-last-message file; fall back to the parsed
        // agent message, then raw stdout.
        let text = std::fs::read_to_string(&out_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or(events.agent_message)
            .unwrap_or_else(|| stdout.trim().to_string());
        let _ = std::fs::remove_file(&out_file);

        if text.trim().is_empty() {
            anyhow::bail!(
                "codex CLI produced no response (is `codex login` done for a ChatGPT/Codex subscription?)"
            );
        }
        Ok(RunOutput {
            text,
            usage: events.usage,
        })
    }
}

#[async_trait]
impl Provider for CliCodexProvider {
    async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
        if *req.cancel.borrow() {
            return Ok(StreamResult {
                content: String::new(),
                usage: None,
                stop_reason: "cancelled".to_string(),
                tool_calls: Vec::new(),
            });
        }
        // Non-streaming: `codex exec` runs its own loop; we run to completion and
        // emit the final agent message as one chunk.
        let prompt = flatten_prompt(&req.messages);
        let out = self.run(&prompt, &req.model).await?;
        let _ = req
            .delta_tx
            .send(ProviderStreamEvent::Content(out.text.clone()));
        Ok(StreamResult {
            content: out.text,
            usage: out.usage,
            stop_reason: "end_turn".to_string(),
            tool_calls: Vec::new(),
        })
    }

    async fn generate_title(&self, user_msg: &str, assistant_msg: &str, model: &str) -> String {
        let prompt = format!(
            "Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: {}\n\nAssistant: {}",
            user_msg.chars().take(500).collect::<String>(),
            assistant_msg.chars().take(500).collect::<String>(),
        );
        match self.run(&prompt, model).await {
            Ok(out) => out.text.trim().chars().take(100).collect(),
            Err(_) => user_msg.chars().take(50).collect(),
        }
    }

    async fn complete_once(
        &self,
        system: &str,
        user: &str,
        model: &str,
        _max_tokens: u32,
    ) -> Option<String> {
        let prompt = if system.is_empty() {
            user.to_string()
        } else {
            format!("{system}\n\n{user}")
        };
        self.run(&prompt, model).await.ok().map(|o| o.text)
    }

    /// Text-only: Codex runs its own agent loop and can't accept Alloy's tool
    /// definitions, so the tool loop must not attach tools for this provider.
    fn supports_tools(&self, _model: &str) -> bool {
        false
    }
}

/// Flatten the conversation into a single prompt string (`codex exec` takes one
/// prompt). System instruction first, then a labeled transcript ending on the
/// latest user turn. Images are dropped (codex exec is text-only here).
fn flatten_prompt(messages: &[ChatMessage]) -> String {
    let mut system: Option<&str> = None;
    let mut turns: Vec<String> = Vec::new();
    for m in messages {
        match m {
            ChatMessage::System { content } => system = Some(content),
            ChatMessage::User { content, .. } => turns.push(format!("User: {content}")),
            ChatMessage::Assistant { content, .. } if !content.is_empty() => {
                turns.push(format!("Assistant: {content}"))
            }
            _ => {}
        }
    }
    // Single user turn: pass its text verbatim (no "User:" label).
    let body = if turns.len() == 1 {
        turns[0]
            .strip_prefix("User: ")
            .unwrap_or(&turns[0])
            .to_string()
    } else {
        turns.join("\n\n")
    };
    match system {
        Some(s) if !s.is_empty() => format!("{s}\n\n{body}"),
        _ => body,
    }
}

#[derive(Default)]
struct CodexEvents {
    agent_message: Option<String>,
    usage: Option<Usage>,
    error: Option<String>,
}

/// Walk the `codex exec --json` JSONL once, collecting the final agent message,
/// token usage, and the first fatal error (if any). Defensive against schema
/// drift and non-JSON lines.
fn parse_events(stdout: &str) -> CodexEvents {
    let mut ev = CodexEvents::default();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(t) = agent_text(&v) {
            ev.agent_message = Some(t);
        }
        if let Some(u) = parse_usage(&v) {
            ev.usage = Some(u);
        }
        if ev.error.is_none() {
            if let Some(e) = parse_error(&v) {
                ev.error = Some(e);
            }
        }
    }
    ev
}

/// Pull an agent/assistant message string out of one codex JSON event, across a
/// few plausible shapes.
fn agent_text(v: &Value) -> Option<String> {
    // Shape A (codex 0.145): {"type":"item.completed","item":{"type":"agent_message","text":...}}
    if let Some(item) = v.get("item") {
        let itype = item
            .get("type")
            .or_else(|| item.get("item_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if itype.contains("agent_message") || itype == "message" || itype == "assistant" {
            if let Some(t) = item
                .get("text")
                .or_else(|| item.get("message"))
                .and_then(Value::as_str)
            {
                return Some(t.to_string());
            }
        }
    }
    // Shape B: {"msg":{"type":"agent_message","message":...}}
    if let Some(msg) = v.get("msg") {
        let mtype = msg.get("type").and_then(Value::as_str).unwrap_or("");
        if mtype.contains("agent_message") || mtype == "assistant" {
            if let Some(t) = msg
                .get("message")
                .or_else(|| msg.get("text"))
                .and_then(Value::as_str)
            {
                return Some(t.to_string());
            }
        }
    }
    // Shape C: {"type":"agent_message","message"|"text":...}
    let ttype = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ttype.contains("agent_message") {
        if let Some(t) = v
            .get("message")
            .or_else(|| v.get("text"))
            .and_then(Value::as_str)
        {
            return Some(t.to_string());
        }
    }
    None
}

/// Token usage from a `turn.completed` event.
fn parse_usage(v: &Value) -> Option<Usage> {
    if v.get("type").and_then(Value::as_str) != Some("turn.completed") {
        return None;
    }
    let u = v.get("usage")?;
    let input = u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
    let output = u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
    if input == 0 && output == 0 {
        return None;
    }
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
        ..Default::default()
    })
}

/// Fatal error text from an `error` or `turn.failed` event (codex nests the API
/// error as a JSON string, so unwrap `.error.message` when present).
fn parse_error(v: &Value) -> Option<String> {
    match v.get("type").and_then(Value::as_str)? {
        "error" => v
            .get("message")
            .and_then(Value::as_str)
            .map(unwrap_error_message),
        "turn.failed" => v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(unwrap_error_message),
        _ => None,
    }
}

fn unwrap_error_message(s: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        if let Some(m) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            return m.to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(content: &str) -> ChatMessage {
        ChatMessage::User {
            content: content.into(),
            images: vec![],
        }
    }
    fn assistant(content: &str) -> ChatMessage {
        ChatMessage::Assistant {
            content: content.into(),
            tool_calls: vec![],
        }
    }

    #[test]
    fn single_turn_passes_text_verbatim() {
        let msgs = vec![
            ChatMessage::System {
                content: "be brief".into(),
            },
            user("what is 2+2?"),
        ];
        assert_eq!(flatten_prompt(&msgs), "be brief\n\nwhat is 2+2?");
    }

    #[test]
    fn multi_turn_builds_labeled_transcript() {
        let msgs = vec![user("hi"), assistant("hello!"), user("how are you?")];
        assert_eq!(
            flatten_prompt(&msgs),
            "User: hi\n\nAssistant: hello!\n\nUser: how are you?"
        );
    }

    // Real codex-cli 0.145 output for a successful turn.
    #[test]
    fn parses_agent_message_and_usage_from_real_output() {
        let out = format!(
            "{}\n{}\n{}\n{}\n",
            json!({"type":"thread.started","thread_id":"abc"}),
            json!({"type":"turn.started"}),
            json!({"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello there, friend!"}}),
            json!({"type":"turn.completed","usage":{"input_tokens":15576,"cached_input_tokens":13056,"output_tokens":9,"reasoning_output_tokens":0}}),
        );
        let ev = parse_events(&out);
        assert_eq!(ev.agent_message.as_deref(), Some("Hello there, friend!"));
        assert!(ev.error.is_none());
        let usage = ev.usage.expect("usage");
        assert_eq!(usage.input_tokens, 15576);
        assert_eq!(usage.output_tokens, 9);
    }

    // Real codex-cli 0.145 output when a ChatGPT account is sent an unsupported
    // model: a metadata warning (ignored), then a fatal error + turn.failed.
    #[test]
    fn surfaces_unsupported_model_error() {
        let out = format!(
            "{}\n{}\n{}\n{}\n",
            json!({"type":"thread.started","thread_id":"abc"}),
            json!({"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5-codex` not found. Defaulting to fallback metadata."}}),
            json!({"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}),
            json!({"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}}),
        );
        let ev = parse_events(&out);
        assert_eq!(
            ev.error.as_deref(),
            Some("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.")
        );
        // The item.completed warning must not be mistaken for the answer.
        assert!(ev.agent_message.is_none());
    }

    #[test]
    fn parses_agent_message_from_msg_shape() {
        let out = json!({"msg":{"type":"agent_message","message":"hello there"}}).to_string();
        assert_eq!(
            parse_events(&out).agent_message.as_deref(),
            Some("hello there")
        );
    }

    #[test]
    fn takes_the_last_agent_message() {
        let out = format!(
            "{}\n{}\n",
            json!({"type":"agent_message","text":"partial"}),
            json!({"type":"agent_message","text":"final answer"}),
        );
        assert_eq!(
            parse_events(&out).agent_message.as_deref(),
            Some("final answer")
        );
    }

    #[test]
    fn resolve_codex_binary_prefers_explicit_config() {
        assert_eq!(resolve_codex_binary(Some("/custom/codex")), "/custom/codex");
        assert_ne!(resolve_codex_binary(Some("")), "");
    }
}
