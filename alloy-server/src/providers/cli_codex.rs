//! Codex CLI provider (OpenAI Codex, ChatGPT/Codex subscription).
//!
//! Shells out to `codex exec` in a read-only sandbox so calls bill against the
//! user's ChatGPT/Codex **subscription** (via `codex login`) rather than an API
//! key. Text-only: Codex runs its own agent loop; Alloy doesn't attach tool
//! definitions or bridge MCP (unlike cli_claude), so the model just answers.
//! Prompts go to OpenAI, so this provider is always CLOUD (never `local`, no
//! private-dir access — enforced in `local::provider_is_local`).
//!
//! NOTE: the exact `codex exec` flags, auth, and `--json` event schema vary by
//! codex version. This is a best-effort integration: the invocation is in
//! [`CliCodexProvider::base_command`] and the output parsing in
//! [`parse_agent_message`]; adjust both if your codex build differs.

use std::process::Stdio;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::ProviderConfig;
use crate::providers::{ChatMessage, Provider, ProviderStreamEvent, StreamRequest, StreamResult};

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

pub struct CliCodexProvider {
    command: String,
}

impl CliCodexProvider {
    pub fn new(cfg: &ProviderConfig) -> Self {
        Self {
            command: resolve_codex_binary(cfg.command.as_deref()),
        }
    }

    fn base_command(&self, model: &str) -> Command {
        let mut cmd = Command::new(&self.command);
        cmd.arg("exec")
            .arg("--model")
            .arg(model)
            // Read-only sandbox: the model can't write files or run networked
            // commands — it just answers. Keeps this a text-only provider.
            .arg("--sandbox")
            .arg("read-only")
            // We run from a neutral temp dir, which isn't a git repo.
            .arg("--skip-git-repo-check")
            // Structured event stream so we can extract just the final message.
            .arg("--json");
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

    /// Run `codex exec` with `prompt` on stdin and return the final agent message.
    async fn run(&self, prompt: &str, model: &str) -> anyhow::Result<String> {
        let mut cmd = self.base_command(model);
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
        if !output.status.success() {
            anyhow::bail!(
                "codex CLI exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let text = parse_agent_message(&String::from_utf8_lossy(&output.stdout));
        if text.trim().is_empty() {
            anyhow::bail!(
                "codex CLI produced no response (is `codex login` done for a ChatGPT/Codex subscription?)"
            );
        }
        Ok(text)
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
        let content = self.run(&prompt, &req.model).await?;
        let _ = req
            .delta_tx
            .send(ProviderStreamEvent::Content(content.clone()));
        Ok(StreamResult {
            content,
            usage: None,
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
            Ok(t) => t.trim().chars().take(100).collect(),
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
        self.run(&prompt, model).await.ok()
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
        turns[0].strip_prefix("User: ").unwrap_or(&turns[0]).to_string()
    } else {
        turns.join("\n\n")
    };
    match system {
        Some(s) if !s.is_empty() => format!("{s}\n\n{body}"),
        _ => body,
    }
}

/// Extract the final agent message from `codex exec --json` output. Defensive
/// against schema variation: tries several known event shapes and takes the
/// last agent message; if no line parses as JSON, returns the raw text.
fn parse_agent_message(stdout: &str) -> String {
    let mut last: Option<String> = None;
    let mut any_json = false;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        any_json = true;
        if let Some(t) = agent_text(&v) {
            last = Some(t);
        }
    }
    match last {
        Some(t) => t,
        None if !any_json => stdout.trim().to_string(),
        None => String::new(),
    }
}

/// Pull an agent/assistant message string out of one codex JSON event, across a
/// few plausible shapes.
fn agent_text(v: &Value) -> Option<String> {
    // Shape A: {"type":"item.completed","item":{"type"|"item_type":"agent_message","text":...}}
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
            ChatMessage::System { content: "be brief".into() },
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

    #[test]
    fn parses_agent_message_from_item_completed() {
        let out = format!(
            "{}\n{}\n",
            json!({"type":"item.started","item":{"type":"reasoning"}}),
            json!({"type":"item.completed","item":{"type":"agent_message","text":"the answer is 4"}}),
        );
        assert_eq!(parse_agent_message(&out), "the answer is 4");
    }

    #[test]
    fn parses_agent_message_from_msg_shape() {
        let out = json!({"msg":{"type":"agent_message","message":"hello there"}}).to_string();
        assert_eq!(parse_agent_message(&out), "hello there");
    }

    #[test]
    fn takes_the_last_agent_message() {
        let out = format!(
            "{}\n{}\n",
            json!({"type":"agent_message","text":"partial"}),
            json!({"type":"agent_message","text":"final answer"}),
        );
        assert_eq!(parse_agent_message(&out), "final answer");
    }

    #[test]
    fn falls_back_to_raw_text_when_not_json() {
        assert_eq!(parse_agent_message("just plain output\n"), "just plain output");
    }

    #[test]
    fn resolve_codex_binary_prefers_explicit_config() {
        assert_eq!(resolve_codex_binary(Some("/custom/codex")), "/custom/codex");
        assert_ne!(resolve_codex_binary(Some("")), "");
    }
}
