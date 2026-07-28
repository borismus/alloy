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
//!   * the app-server `model/list` method returns the authenticated account's
//!     current catalog, including exact ids and the account default.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::Command;

use crate::config::ProviderConfig;
use crate::providers::{
    ChatMessage, DiscoveredModel, Provider, ProviderStreamEvent, StreamRequest, StreamResult, Usage,
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

#[derive(Deserialize)]
struct CodexModelList {
    data: Vec<CodexModelEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexModelEntry {
    id: String,
    model: String,
    display_name: String,
    hidden: bool,
    is_default: bool,
}

impl CliCodexProvider {
    pub fn new(cfg: &ProviderConfig) -> Self {
        Self {
            command: resolve_codex_binary(cfg.command.as_deref()),
        }
    }

    /// Ask Codex's app-server for the authenticated account's live model
    /// catalog. This is a metadata-only RPC and does not start an inference turn.
    pub(crate) async fn discover_models(&self) -> Result<Vec<DiscoveredModel>, String> {
        let mut cmd = self.command();
        cmd.arg("app-server")
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to launch `{}` app-server: {e}", self.command))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout unavailable".to_string())?;
        let mut lines = BufReader::new(stdout).lines();

        let exchange = async {
            write_rpc(
                &mut stdin,
                &serde_json::json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {"clientInfo": {"name": "alloy", "version": env!("CARGO_PKG_VERSION")}}
                }),
            )
            .await?;
            ensure_rpc_success(read_rpc_response(&mut lines, 1).await?)?;
            write_rpc(
                &mut stdin,
                &serde_json::json!({"method": "initialized", "params": {}}),
            )
            .await?;
            write_rpc(
                &mut stdin,
                &serde_json::json!({
                    "id": 2,
                    "method": "config/read",
                    "params": {"includeLayers": false}
                }),
            )
            .await?;
            let configured_model =
                parse_configured_model(&read_rpc_response(&mut lines, 2).await?)?;
            write_rpc(
                &mut stdin,
                &serde_json::json!({
                    "id": 3,
                    "method": "model/list",
                    "params": {"includeHidden": false, "limit": 100}
                }),
            )
            .await?;
            parse_model_list_response(
                &read_rpc_response(&mut lines, 3).await?,
                configured_model.as_deref(),
            )
        };
        let discovered = match tokio::time::timeout(Duration::from_secs(20), exchange).await {
            Ok(result) => result,
            Err(_) => Err("Codex `model/list` timed out".to_string()),
        };
        let _ = child.start_kill();
        let _ = child.wait().await;
        discovered
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.command);
        cmd.current_dir(std::env::temp_dir());
        let home = std::env::var("HOME").unwrap_or_default();
        let existing = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{existing}"),
        );
        // Force subscription billing: an API key would switch codex to API
        // billing, so scrub it for discovery as well as inference.
        cmd.env_remove("OPENAI_API_KEY");
        cmd
    }

    fn base_command(&self, model: &str, out_file: &Path) -> Command {
        let mut cmd = self.command();
        cmd.arg("exec");
        // "default" preserves Codex's account/config-selected model. Exact ids
        // returned by discovery are passed through with `--model`.
        if !model.is_empty() && model != "default" {
            cmd.arg("--model").arg(model);
        }
        cmd.arg("--sandbox")
            .arg("read-only")
            .arg("--skip-git-repo-check")
            .arg("--json")
            .arg("--output-last-message")
            .arg(out_file);
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

async fn write_rpc(stdin: &mut tokio::process::ChildStdin, message: &Value) -> Result<(), String> {
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|e| format!("Codex app-server write failed: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Codex app-server write failed: {e}"))
}

async fn read_rpc_response<R: AsyncBufRead + Unpin>(
    lines: &mut Lines<R>,
    id: u64,
) -> Result<Value, String> {
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("Codex app-server read failed: {e}"))?
    {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            return Ok(message);
        }
    }
    Err(format!("Codex app-server closed before RPC {id} completed"))
}

fn ensure_rpc_success(response: Value) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        Err(format!("Codex app-server error: {error}"))
    } else if response.get("result").is_some() {
        Ok(response)
    } else {
        Err("Codex app-server response had no result".to_string())
    }
}

fn parse_configured_model(response: &Value) -> Result<Option<String>, String> {
    ensure_rpc_success(response.clone())?;
    Ok(response
        .pointer("/result/config/model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(str::to_string))
}

fn parse_model_list_response(
    response: &Value,
    configured_model: Option<&str>,
) -> Result<Vec<DiscoveredModel>, String> {
    ensure_rpc_success(response.clone())?;
    let list = serde_json::from_value::<CodexModelList>(
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex `model/list` response had no result".to_string())?,
    )
    .map_err(|e| format!("could not parse Codex `model/list` response: {e}"))?;
    let models = list
        .data
        .into_iter()
        .filter(|entry| !entry.hidden)
        .map(|entry| {
            let is_default = configured_model
                .map(|configured| configured == entry.model)
                .unwrap_or(entry.is_default);
            DiscoveredModel {
                id: if entry.model.is_empty() {
                    entry.id
                } else {
                    entry.model
                },
                name: entry.display_name,
                // The app-server catalog does not currently expose this field.
                // The active Codex catalog uses a 272k context window.
                context_window: Some(272_000),
                is_default,
            }
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        Err("Codex `model/list` returned no selectable models".to_string())
    } else {
        Ok(models)
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
    fn parses_visible_app_server_models_and_default() {
        let response = json!({
            "id": 2,
            "result": {"data": [
                {"id":"gpt-best","model":"gpt-best","displayName":"GPT Best","hidden":false,"isDefault":true},
                {"id":"hidden","model":"hidden","displayName":"Hidden","hidden":true,"isDefault":false},
                {"id":"gpt-fast","model":"gpt-fast","displayName":"GPT Fast","hidden":false,"isDefault":false}
            ], "nextCursor": null}
        });
        let models = parse_model_list_response(&response, None).expect("catalog");
        assert_eq!(
            models,
            vec![
                DiscoveredModel {
                    id: "gpt-best".into(),
                    name: "GPT Best".into(),
                    context_window: Some(272_000),
                    is_default: true,
                },
                DiscoveredModel {
                    id: "gpt-fast".into(),
                    name: "GPT Fast".into(),
                    context_window: Some(272_000),
                    is_default: false,
                },
            ]
        );
        let configured = parse_model_list_response(&response, Some("gpt-fast")).expect("catalog");
        assert!(!configured[0].is_default);
        assert!(configured[1].is_default);
    }

    #[test]
    fn resolve_codex_binary_prefers_explicit_config() {
        assert_eq!(resolve_codex_binary(Some("/custom/codex")), "/custom/codex");
        assert_ne!(resolve_codex_binary(Some("")), "");
    }
}
