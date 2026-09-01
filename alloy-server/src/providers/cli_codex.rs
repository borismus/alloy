//! Codex CLI provider (OpenAI Codex, ChatGPT/Codex subscription).
//!
//! Interactive turns use Codex's app-server JSON-RPC protocol so calls bill
//! against the user's ChatGPT/Codex **subscription** (via `codex login`) while
//! still providing token deltas, turn interruption, images, and Alloy's MCP
//! tools. Small internal one-shot tasks (titles/compaction) retain `codex exec`.
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
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::Command;

use crate::config::ProviderConfig;
use crate::providers::{
    fallback_title, sanitize_title, ChatMessage, DiscoveredModel, McpBridge, Provider,
    ProviderStreamEvent, StreamRequest, StreamResult, Usage,
};
use crate::types::{ToolCall, ToolResult};

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
    std::env::temp_dir().join(format!(
        "alloy-codex-{}-{nanos}-{n}.txt",
        std::process::id()
    ))
}

pub struct CliCodexProvider {
    command: String,
}

struct RunOutput {
    text: String,
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

    fn base_command(&self, model: &str, out_file: &Path, mcp: Option<&McpBridge>) -> Command {
        let mut cmd = self.command();
        cmd.arg("exec");
        // "default" preserves Codex's account/config-selected model. Exact ids
        // returned by discovery are passed through with `--model`.
        if !model.is_empty() && model != "default" {
            cmd.arg("--model").arg(model);
        }
        cmd.arg("--skip-git-repo-check")
            .arg("--json")
            .arg("--output-last-message")
            .arg(out_file);
        // Give Codex Alloy's built-in tools over the same MCP-over-HTTP bridge
        // the claude-cli provider uses, so both subscription providers dispatch
        // through the identical `ToolRegistry::execute` (same vault scoping and
        // side effects). `-c` values are parsed as TOML, hence the quoting; the
        // URL is loopback with uuid-shaped ids, so it needs no escaping.
        if let Some(mcp) = mcp {
            cmd.arg("-c").arg(format!(
                r#"mcp_servers.alloy.url="{}/api/mcp?session={}&token={}""#,
                mcp.base_url, mcp.session_id, mcp.token
            ));
            // Codex gates MCP tool calls behind an approval prompt. Under plain
            // `exec` there is nobody to answer it, so every call is auto-
            // cancelled and the model reports "the request was canceled" — it
            // connects and lists tools but never invokes one. `--approve-for-me`
            // routes approvals through Codex's own automatic review. Applied
            // ONLY alongside the bridge: a text-only turn keeps the stricter
            // default. Deliberately NOT
            // `--dangerously-bypass-approvals-and-sandbox`, which would also
            // unsandbox Codex's own shell tools.
            //
            // `--approve-for-me` is mutually exclusive with `--sandbox` (the CLI
            // rejects both: "cannot be used with"), and implies workspace-write.
            // That is contained here because `command()` runs Codex from
            // `std::env::temp_dir()`, never the vault or a project checkout, so
            // its native tools can only touch scratch space — the vault is
            // reachable solely through Alloy's MCP tools, which enforce their own
            // scoping.
            cmd.arg("--approve-for-me");
        } else {
            // No tools this turn: keep the strictest sandbox.
            cmd.arg("--sandbox").arg("read-only");
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    fn app_server_command(&self, mcp: Option<&McpBridge>) -> Command {
        let mut cmd = self.command();
        cmd.arg("app-server").arg("--stdio");
        if let Some(mcp) = mcp {
            cmd.arg("-c").arg(format!(
                r#"mcp_servers.alloy.url="{}/api/mcp?session={}&token={}""#,
                mcp.base_url, mcp.session_id, mcp.token
            ));
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    /// Run `codex exec` with `prompt` on stdin and return its final message.
    /// Interactive user turns use app-server below; this path remains for title
    /// generation and compaction, which need only one result.
    async fn run(
        &self,
        prompt: &str,
        model: &str,
        mcp: Option<&McpBridge>,
    ) -> anyhow::Result<RunOutput> {
        let out_file = last_message_path();
        let mut cmd = self.base_command(model, &out_file, mcp);
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
        Ok(RunOutput { text })
    }

    /// Run one interactive turn through app-server. Unlike `codex exec --json`,
    /// app-server exposes actual token deltas, a turn interrupt RPC, and image
    /// inputs. One ephemeral process/thread per Alloy turn keeps lifecycle and
    /// cancellation ownership simple and avoids persisting duplicate sessions.
    async fn run_app_server(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
        let prompt = flatten_prompt(&req.messages);
        let input = app_server_input(&prompt, &req.messages);
        let has_mcp = req.mcp.is_some();
        let mut cancel = req.cancel;
        if *cancel.borrow() {
            return Ok(cancelled_result(String::new(), None));
        }

        let mut cmd = self.app_server_command(req.mcp.as_ref());
        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "failed to launch the `codex` app-server at `{}`: {}. Install the OpenAI Codex CLI and run `codex login`, or set the provider's `command` to its absolute path.",
                self.command,
                e
            )
        })?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stdout unavailable"))?;
        let mut lines = BufReader::new(stdout).lines();
        let stderr_handle = child.stderr.take().map(|mut stderr| {
            tokio::spawn(async move {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text).await;
                text
            })
        });

        write_rpc(
            &mut stdin,
            &serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "alloy", "version": env!("CARGO_PKG_VERSION")}}
            }),
        )
        .await
        .map_err(anyhow::Error::msg)?;
        ensure_rpc_success(
            read_rpc_response(&mut lines, 1)
                .await
                .map_err(anyhow::Error::msg)?,
        )
        .map_err(anyhow::Error::msg)?;
        write_rpc(
            &mut stdin,
            &serde_json::json!({"method": "initialized", "params": {}}),
        )
        .await
        .map_err(anyhow::Error::msg)?;

        write_rpc(
            &mut stdin,
            &serde_json::json!({
                "id": 2,
                "method": "thread/start",
                "params": app_server_thread_start_params(&req.model, has_mcp)
            }),
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let thread_response = ensure_rpc_success(
            read_rpc_response(&mut lines, 2)
                .await
                .map_err(anyhow::Error::msg)?,
        )
        .map_err(anyhow::Error::msg)?;
        let thread_id = thread_response
            .pointer("/result/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex thread/start response had no thread id"))?
            .to_string();

        write_rpc(
            &mut stdin,
            &serde_json::json!({
                "id": 3,
                "method": "turn/start",
                "params": {"threadId": thread_id, "input": input}
            }),
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let turn_response = ensure_rpc_success(
            read_rpc_response(&mut lines, 3)
                .await
                .map_err(anyhow::Error::msg)?,
        )
        .map_err(anyhow::Error::msg)?;
        let turn_id = turn_response
            .pointer("/result/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex turn/start response had no turn id"))?
            .to_string();

        let mut content = String::new();
        let mut last_agent_message_item_id: Option<String> = None;
        let mut usage: Option<Usage> = None;
        let mut error: Option<String> = None;
        let mut completion: Option<AppServerCompletion> = None;
        let mut cancel_requested = false;
        let mut cancel_watch_open = true;
        let mut cancel_deadline: Option<tokio::time::Instant> = None;

        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        Ok(None) => break,
                        Err(e) => {
                            error = Some(format!("Codex app-server stdout read failed: {e}"));
                            break;
                        }
                    };
                    let Ok(message): Result<Value, _> = serde_json::from_str(&line) else {
                        continue;
                    };
                    if let Some((item_id, delta)) = app_server_delta(&message, &thread_id, &turn_id) {
                        let visible_delta = append_app_server_delta(
                            &mut content,
                            &mut last_agent_message_item_id,
                            item_id,
                            delta,
                        );
                        if !visible_delta.is_empty() {
                            let _ = req.delta_tx.send(ProviderStreamEvent::Content(visible_delta));
                        }
                    }
                    if let Some(delta) = app_server_thinking_delta(&message, &thread_id, &turn_id) {
                        let _ = req.delta_tx.send(ProviderStreamEvent::Thinking(delta.to_string()));
                    }
                    if let Some(next_usage) = app_server_usage(&message, &thread_id, &turn_id) {
                        usage = Some(next_usage);
                    }
                    if let Some(call) = app_server_tool_use(&message, &thread_id, &turn_id) {
                        req.tool_sink.on_tool_use(&call);
                    }
                    // Native web-search start events contain `query: ""`;
                    // Codex fills the real query only on completion. Re-emit
                    // that call by id so the session/UI can update it in place.
                    if let Some(call) = app_server_tool_update(&message, &thread_id, &turn_id) {
                        req.tool_sink.on_tool_use(&call);
                    }
                    if let Some(result) = app_server_tool_result(&message, &thread_id, &turn_id) {
                        req.tool_sink.on_tool_result(&result);
                    }
                    if error.is_none() {
                        error = app_server_error(&message, &thread_id, &turn_id);
                    }
                    if let Some(done) = app_server_completion(&message, &thread_id, &turn_id) {
                        completion = Some(done);
                        break;
                    }
                }
                changed = cancel.changed(), if !cancel_requested && cancel_watch_open => {
                    match changed {
                        Ok(()) if *cancel.borrow() => {
                            cancel_requested = true;
                            cancel_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                            // Graceful interruption preserves any partial deltas and
                            // produces a normal `turn/completed: interrupted` event.
                            // The deadline below kills a wedged child as a backstop.
                            let _ = write_rpc(
                                &mut stdin,
                                &serde_json::json!({
                                    "id": 4,
                                    "method": "turn/interrupt",
                                    "params": {"threadId": thread_id, "turnId": turn_id}
                                }),
                            ).await;
                        }
                        Ok(()) => {}
                        Err(_) => cancel_watch_open = false,
                    }
                }
                _ = async {
                    tokio::time::sleep_until(cancel_deadline.expect("guarded deadline")).await;
                }, if cancel_deadline.is_some() => {
                    let _ = child.start_kill();
                    break;
                }
            }
        }

        let _ = child.start_kill();
        let status = child.wait().await.ok();
        let stderr = match stderr_handle {
            Some(handle) => handle.await.unwrap_or_default(),
            None => String::new(),
        };
        let cancelled = cancel_requested
            || *cancel.borrow()
            || completion.as_ref().map(|c| c.status.as_str()) == Some("interrupted");

        // Some app-server versions may complete without delta notifications.
        // Emit the final item once as a compatibility fallback.
        if content.is_empty() {
            if let Some(final_text) = completion.as_ref().and_then(|c| c.text.as_ref()) {
                if !final_text.is_empty() {
                    content = final_text.clone();
                    let _ = req
                        .delta_tx
                        .send(ProviderStreamEvent::Content(final_text.clone()));
                }
            }
        }

        if !cancelled {
            if let Some(done_error) = completion.as_ref().and_then(|c| c.error.clone()) {
                anyhow::bail!("codex app-server: {done_error}");
            }
            if let Some(message) = error {
                anyhow::bail!("codex app-server: {message}");
            }
            if completion.is_none() {
                let detail = if stderr.trim().is_empty() {
                    status
                        .map(|s| format!("process exited {s}"))
                        .unwrap_or_else(|| "process ended before turn/completed".to_string())
                } else {
                    stderr.trim().to_string()
                };
                anyhow::bail!("codex app-server ended early: {detail}");
            }
            if content.trim().is_empty() {
                anyhow::bail!("codex app-server produced no response");
            }
        }

        if cancelled {
            Ok(cancelled_result(content, usage))
        } else {
            Ok(StreamResult {
                content,
                usage,
                stop_reason: "end_turn".to_string(),
                tool_calls: Vec::new(),
            })
        }
    }
}

#[async_trait]
impl Provider for CliCodexProvider {
    async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
        self.run_app_server(req).await
    }

    fn title_model(&self, _conversation_model: &str) -> String {
        // Omitting --model lets Codex use the authenticated account/config
        // default. Passing an OpenRouter/Anthropic id here makes `codex exec`
        // fail and silently degrades the title to the raw user-message prefix.
        "default".to_string()
    }

    async fn generate_title(&self, user_msg: &str, assistant_msg: &str, model: &str) -> String {
        let prompt = format!(
            "Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: {}\n\nAssistant: {}",
            user_msg.chars().take(500).collect::<String>(),
            assistant_msg.chars().take(500).collect::<String>(),
        );
        // No MCP bridge: titling is a pure text summarization, and giving it
        // vault tools would let a title request take side effects.
        match self.run(&prompt, model, None).await {
            Ok(out) => sanitize_title(&out.text, user_msg),
            Err(error) => {
                tracing::warn!("Codex title generation failed: {}", error);
                fallback_title(user_msg)
            }
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
        self.run(&prompt, model, None).await.ok().map(|o| o.text)
    }

    /// Codex runs its own agent loop and can't accept Alloy's `ToolDefinition`s
    /// in-band, so the tool loop must not attach them. It still reaches full
    /// tool parity: `base_command` hands it Alloy's MCP bridge, exactly as the
    /// claude-cli provider does, and those calls dispatch through the same
    /// `ToolRegistry::execute`.
    fn supports_tools(&self, _model: &str) -> bool {
        false
    }

    /// App-server accepts both image data URLs and local image paths. Alloy has
    /// already resolved vault attachments to base64, so turns use data URLs and
    /// never grant Codex direct filesystem access to the vault.
    fn supports_images(&self, _model: &str) -> bool {
        true
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

fn app_server_thread_start_params(model: &str, has_mcp: bool) -> Value {
    serde_json::json!({
        "cwd": std::env::temp_dir().to_string_lossy(),
        "model": if model.is_empty() || model == "default" { Value::Null } else { Value::String(model.to_string()) },
        "sandbox": if has_mcp { "workspace-write" } else { "read-only" },
        "approvalPolicy": if has_mcp { "on-request" } else { "never" },
        // Equivalent to `codex exec --approve-for-me`: MCP approvals are
        // reviewed internally instead of becoming unanswered client requests.
        "approvalsReviewer": if has_mcp { Value::String("auto_review".into()) } else { Value::Null },
        "ephemeral": true,
    })
}

/// Build one app-server turn from Alloy's flattened transcript plus every image
/// attachment in message order. Data URLs keep vault paths private from Codex.
fn app_server_input(prompt: &str, messages: &[ChatMessage]) -> Vec<Value> {
    let mut input = vec![serde_json::json!({"type": "text", "text": prompt})];
    for message in messages {
        if let ChatMessage::User { images, .. } = message {
            for image in images {
                input.push(serde_json::json!({
                    "type": "image",
                    "url": format!("data:{};base64,{}", image.mime_type, image.base64),
                }));
            }
        }
    }
    input
}

fn app_server_event_matches(v: &Value, method: &str, thread_id: &str, turn_id: &str) -> bool {
    v.get("method").and_then(Value::as_str) == Some(method)
        && v.pointer("/params/threadId").and_then(Value::as_str) == Some(thread_id)
        && (v.pointer("/params/turnId").and_then(Value::as_str) == Some(turn_id)
            || v.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id))
}

fn app_server_delta<'a>(
    v: &'a Value,
    thread_id: &str,
    turn_id: &str,
) -> Option<(&'a str, &'a str)> {
    if !app_server_event_matches(v, "item/agentMessage/delta", thread_id, turn_id) {
        return None;
    }
    Some((
        v.pointer("/params/itemId").and_then(Value::as_str)?,
        v.pointer("/params/delta").and_then(Value::as_str)?,
    ))
}

/// Codex emits commentary and final answers as separate `agentMessage` items.
/// Their individual text is well-formed, but neither side includes boundary
/// whitespace, so blindly concatenating deltas produces `sentence.Next`.
fn append_app_server_delta(
    content: &mut String,
    last_item_id: &mut Option<String>,
    item_id: &str,
    delta: &str,
) -> String {
    if delta.is_empty() {
        return String::new();
    }

    let starts_new_item = last_item_id
        .as_deref()
        .is_some_and(|previous| previous != item_id);
    let needs_separator = starts_new_item
        && !content.is_empty()
        && !content.chars().next_back().is_some_and(char::is_whitespace)
        && !delta.chars().next().is_some_and(char::is_whitespace);

    let mut visible = String::with_capacity(delta.len() + usize::from(needs_separator) * 2);
    if needs_separator {
        visible.push_str("\n\n");
        content.push_str("\n\n");
    }
    visible.push_str(delta);
    content.push_str(delta);
    *last_item_id = Some(item_id.to_string());
    visible
}

fn app_server_thinking_delta<'a>(v: &'a Value, thread_id: &str, turn_id: &str) -> Option<&'a str> {
    app_server_event_matches(v, "item/reasoning/summaryTextDelta", thread_id, turn_id)
        .then(|| v.pointer("/params/delta").and_then(Value::as_str))
        .flatten()
}

fn app_server_usage(v: &Value, thread_id: &str, turn_id: &str) -> Option<Usage> {
    if !app_server_event_matches(v, "thread/tokenUsage/updated", thread_id, turn_id) {
        return None;
    }
    let last = v.pointer("/params/tokenUsage/last")?;
    let input = last.get("inputTokens").and_then(Value::as_u64).unwrap_or(0);
    let output = last
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    Some(Usage {
        input_tokens: input.min(u32::MAX as u64) as u32,
        output_tokens: output.min(u32::MAX as u64) as u32,
        ..Default::default()
    })
}

fn app_server_error(v: &Value, thread_id: &str, turn_id: &str) -> Option<String> {
    if !app_server_event_matches(v, "error", thread_id, turn_id)
        || v.pointer("/params/willRetry").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    v.pointer("/params/error/message")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn app_server_item<'a>(
    v: &'a Value,
    method: &str,
    thread_id: &str,
    turn_id: &str,
) -> Option<&'a Value> {
    app_server_event_matches(v, method, thread_id, turn_id)
        .then(|| v.pointer("/params/item"))
        .flatten()
}

/// Translate both Alloy MCP calls and Codex's native app-server tools into the
/// one ToolCall stream the UI already renders. The initial app-server migration
/// handled only `mcpToolCall`, so native command/web/file activity happened but
/// remained invisible in the thread.
fn app_server_tool_use(v: &Value, thread_id: &str, turn_id: &str) -> Option<ToolCall> {
    let item = app_server_item(v, "item/started", thread_id, turn_id)?;
    let id = item.get("id")?.as_str()?.to_string();
    let (name, input) = match item.get("type").and_then(Value::as_str)? {
        "mcpToolCall" | "dynamicToolCall" => (
            item.get("tool")?.as_str()?.to_string(),
            item.get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        ),
        "commandExecution" => (
            "command_execution".to_string(),
            serde_json::json!({
                "command": item.get("command").and_then(Value::as_str).unwrap_or_default(),
                "cwd": item.get("cwd").and_then(Value::as_str).unwrap_or_default(),
            }),
        ),
        "fileChange" => {
            // Keep patches themselves out of UI state/YAML; the pill only needs
            // the affected paths and operation kinds.
            let changes = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .map(|change| {
                            serde_json::json!({
                                "path": change.get("path").and_then(Value::as_str).unwrap_or_default(),
                                "kind": change.get("kind").and_then(Value::as_str).unwrap_or_default(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (
                "file_change".to_string(),
                serde_json::json!({ "changes": changes }),
            )
        }
        "webSearch" => ("web_search".to_string(), app_server_web_search_input(item)),
        _ => return None,
    };
    Some(ToolCall { id, name, input })
}

fn app_server_web_search_input(item: &Value) -> Value {
    let query = item
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_string)
        .or_else(|| {
            item.pointer("/action/query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|query| !query.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            item.pointer("/action/queries")
                .and_then(Value::as_array)
                .map(|queries| {
                    queries
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|query| !query.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · ")
                })
                .filter(|query| !query.is_empty())
        });

    if let Some(query) = query {
        return serde_json::json!({ "query": query });
    }

    match item.pointer("/action/type").and_then(Value::as_str) {
        Some("openPage") => item
            .pointer("/action/url")
            .and_then(Value::as_str)
            .map(|url| serde_json::json!({ "url": url }))
            .unwrap_or_else(|| serde_json::json!({})),
        Some("findInPage") => serde_json::json!({
            "url": item.pointer("/action/url").and_then(Value::as_str).unwrap_or_default(),
            "query": item.pointer("/action/pattern").and_then(Value::as_str).unwrap_or_default(),
        }),
        _ => serde_json::json!({}),
    }
}

fn app_server_tool_update(v: &Value, thread_id: &str, turn_id: &str) -> Option<ToolCall> {
    let item = app_server_item(v, "item/completed", thread_id, turn_id)?;
    if item.get("type").and_then(Value::as_str) != Some("webSearch") {
        return None;
    }
    let input = app_server_web_search_input(item);
    if input.as_object().is_none_or(serde_json::Map::is_empty) {
        return None;
    }
    Some(ToolCall {
        id: item.get("id")?.as_str()?.to_string(),
        name: "web_search".to_string(),
        input,
    })
}

fn app_server_tool_result(v: &Value, thread_id: &str, turn_id: &str) -> Option<ToolResult> {
    let item = app_server_item(v, "item/completed", thread_id, turn_id)?;
    let kind = item.get("type").and_then(Value::as_str)?;
    if !matches!(
        kind,
        "mcpToolCall" | "dynamicToolCall" | "commandExecution" | "fileChange" | "webSearch"
    ) {
        return None;
    }

    let status = item.get("status").and_then(Value::as_str);
    let is_error = matches!(status, Some("failed" | "declined"))
        || item
            .get("exitCode")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        || item.get("success").and_then(Value::as_bool) == Some(false)
        || item.get("error").is_some_and(|error| !error.is_null());
    let error = item
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_string);

    let content = match kind {
        "mcpToolCall" => item
            .pointer("/result/content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| {
                        part.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| part.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|text| !text.is_empty()),
        "dynamicToolCall" => item.get("contentItems").and_then(|content| {
            (!content.is_null()).then(|| serde_json::to_string(content).unwrap_or_default())
        }),
        "commandExecution" => item
            .get("aggregatedOutput")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .or_else(|| {
                item.get("exitCode")
                    .and_then(Value::as_i64)
                    .map(|code| format!("Command exited with status {code}"))
            }),
        "fileChange" => item
            .get("changes")
            .and_then(Value::as_array)
            .map(|changes| format!("Applied {} file change(s)", changes.len())),
        "webSearch" => item
            .get("results")
            .and_then(Value::as_array)
            .map(|results| format!("Found {} result(s)", results.len())),
        _ => None,
    }
    .or(error)
    .unwrap_or_else(|| "Completed".to_string());

    Some(ToolResult {
        tool_use_id: item.get("id")?.as_str()?.to_string(),
        content,
        is_error: is_error.then_some(true),
    })
}

struct AppServerCompletion {
    status: String,
    text: Option<String>,
    error: Option<String>,
}

fn app_server_completion(v: &Value, thread_id: &str, turn_id: &str) -> Option<AppServerCompletion> {
    if !app_server_event_matches(v, "turn/completed", thread_id, turn_id) {
        return None;
    }
    let turn = v.pointer("/params/turn")?;
    let text = turn
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().rev().find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                    .then(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                    .flatten()
            })
        });
    Some(AppServerCompletion {
        status: turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_string(),
        text,
        error: turn
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn cancelled_result(content: String, usage: Option<Usage>) -> StreamResult {
    StreamResult {
        content,
        usage,
        stop_reason: "cancelled".to_string(),
        tool_calls: Vec::new(),
    }
}

/// Flatten the conversation into a single prompt string. System instruction
/// first, then a labeled transcript ending on the latest user turn. Images are
/// attached separately as app-server input items.
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

    fn provider() -> CliCodexProvider {
        CliCodexProvider::new(&crate::config::ProviderConfig {
            id: "codex-cli".into(),
            kind: crate::config::ProviderKind::Cli,
            adapter: Some(crate::config::CliAdapter::Codex),
            base_url: None,
            api_key: String::new(),
            command: None,
            oauth_token: None,
            local: None,
        })
    }

    fn args_for(mcp: Option<&McpBridge>) -> Vec<String> {
        let cmd = provider().base_command("default", Path::new("/tmp/out.txt"), mcp);
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn app_server_args(mcp: Option<&McpBridge>) -> Vec<String> {
        let cmd = provider().app_server_command(mcp);
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn stream_request(
        messages: Vec<ChatMessage>,
        cancel: tokio::sync::watch::Receiver<bool>,
        delta_tx: tokio::sync::mpsc::UnboundedSender<ProviderStreamEvent>,
    ) -> StreamRequest {
        StreamRequest {
            messages,
            model: "default".into(),
            tools: Vec::new(),
            delta_tx,
            cancel,
            retry_connect: false,
            tool_sink: std::sync::Arc::new(crate::types::NullSink),
            mcp: None,
        }
    }

    #[cfg(unix)]
    fn scripted_provider(script: &str) -> (CliCodexProvider, tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake-codex");
        std::fs::write(&path, script).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        let cfg = crate::config::ProviderConfig {
            id: "codex-cli".into(),
            kind: crate::config::ProviderKind::Cli,
            adapter: Some(crate::config::CliAdapter::Codex),
            base_url: None,
            api_key: String::new(),
            command: Some(path.to_string_lossy().into_owned()),
            oauth_token: None,
            local: None,
        };
        (CliCodexProvider::new(&cfg), dir)
    }

    #[test]
    fn attaches_the_alloy_mcp_bridge_when_one_is_supplied() {
        let bridge = McpBridge {
            base_url: "http://127.0.0.1:4321".into(),
            session_id: "sess-1".into(),
            token: "tok-2".into(),
        };
        let args = args_for(Some(&bridge));
        assert!(
            args.iter().any(|a| a
                == r#"mcp_servers.alloy.url="http://127.0.0.1:4321/api/mcp?session=sess-1&token=tok-2""#),
            "missing MCP config: {args:?}"
        );
        // Codex gates MCP tool calls behind approval; under plain `exec` there
        // is nobody to answer, so calls are auto-cancelled and it lists tools
        // but never invokes one.
        assert!(args.iter().any(|a| a == "--approve-for-me"), "{args:?}");
        // Mutually exclusive with --approve-for-me: the CLI errors out if both
        // are passed ("cannot be used with").
        assert!(!args.iter().any(|a| a == "--sandbox"), "{args:?}");
    }

    #[test]
    fn app_server_preserves_mcp_config_and_automatic_review() {
        let bridge = McpBridge {
            base_url: "http://127.0.0.1:4321".into(),
            session_id: "sess-1".into(),
            token: "tok-2".into(),
        };
        let args = app_server_args(Some(&bridge));
        assert!(args.iter().any(|a| a == "app-server"), "{args:?}");
        assert!(
            args.iter().any(|a| a
                == r#"mcp_servers.alloy.url="http://127.0.0.1:4321/api/mcp?session=sess-1&token=tok-2""#),
            "missing MCP config: {args:?}"
        );
        let params = app_server_thread_start_params("default", true);
        assert_eq!(params["sandbox"], "workspace-write");
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["approvalsReviewer"], "auto_review");
        assert_eq!(params["ephemeral"], true);
    }

    #[test]
    fn keeps_the_read_only_sandbox_when_there_are_no_tools() {
        let args = args_for(None);
        assert!(args.iter().any(|a| a == "--sandbox"), "{args:?}");
        assert!(args.iter().any(|a| a == "read-only"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--approve-for-me"), "{args:?}");
        assert!(
            !args.iter().any(|a| a.starts_with("mcp_servers")),
            "{args:?}"
        );
    }

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

    #[test]
    fn app_server_attaches_images_as_data_urls() {
        let messages = vec![ChatMessage::User {
            content: "what color?".into(),
            images: vec![crate::providers::ImageData {
                mime_type: "image/png".into(),
                base64: "aGVsbG8=".into(),
            }],
        }];
        let input = app_server_input("what color?", &messages);
        assert_eq!(input[0], json!({"type": "text", "text": "what color?"}));
        assert_eq!(
            input[1],
            json!({"type": "image", "url": "data:image/png;base64,aGVsbG8="})
        );
    }

    #[test]
    fn parses_real_app_server_delta_usage_and_completion_events() {
        let delta = json!({
            "method": "item/agentMessage/delta",
            "params": {"threadId": "thread", "turnId": "turn", "itemId": "msg", "delta": "Hello"}
        });
        assert_eq!(
            app_server_delta(&delta, "thread", "turn"),
            Some(("msg", "Hello"))
        );
        assert!(app_server_delta(&delta, "other", "turn").is_none());

        let usage = json!({
            "method": "thread/tokenUsage/updated",
            "params": {"threadId": "thread", "turnId": "turn", "tokenUsage": {
                "last": {"inputTokens": 13423, "outputTokens": 32}
            }}
        });
        let usage = app_server_usage(&usage, "thread", "turn").unwrap();
        assert_eq!(usage.input_tokens, 13423);
        assert_eq!(usage.output_tokens, 32);

        let completed = json!({
            "method": "turn/completed",
            "params": {"threadId": "thread", "turn": {
                "id": "turn", "status": "completed", "error": null,
                "items": [{"type": "agentMessage", "text": "Hello", "phase": "final_answer"}]
            }}
        });
        let completed = app_server_completion(&completed, "thread", "turn").unwrap();
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.text.as_deref(), Some("Hello"));
        assert!(completed.error.is_none());
    }

    #[test]
    fn separates_distinct_app_server_agent_messages() {
        let mut content = String::new();
        let mut last_item_id = None;

        assert_eq!(
            append_app_server_delta(
                &mut content,
                &mut last_item_id,
                "commentary-1",
                "I’ll inspect the exact page."
            ),
            "I’ll inspect the exact page."
        );
        // Deltas within one item remain byte-for-byte adjacent.
        assert_eq!(
            append_app_server_delta(
                &mut content,
                &mut last_item_id,
                "commentary-1",
                " More commentary."
            ),
            " More commentary."
        );
        // A new agentMessage item gets a paragraph boundary when Codex omits
        // whitespace on both sides of the item transition.
        assert_eq!(
            append_app_server_delta(
                &mut content,
                &mut last_item_id,
                "final-answer-1",
                "That confirms the wiring:"
            ),
            "\n\nThat confirms the wiring:"
        );
        assert_eq!(
            content,
            "I’ll inspect the exact page. More commentary.\n\nThat confirms the wiring:"
        );
    }

    #[test]
    fn parses_app_server_mcp_tool_events() {
        let started = json!({
            "method": "item/started",
            "params": {"threadId": "thread", "turnId": "turn", "item": {
                "type": "mcpToolCall", "id": "call-1", "server": "alloy",
                "tool": "read_file", "status": "inProgress", "arguments": {"path": "notes/x.md"}
            }}
        });
        let call = app_server_tool_use(&started, "thread", "turn").unwrap();
        assert_eq!(call.id, "call-1");
        assert_eq!(call.name, "read_file");
        assert_eq!(call.input, json!({"path": "notes/x.md"}));

        let completed = json!({
            "method": "item/completed",
            "params": {"threadId": "thread", "turnId": "turn", "item": {
                "type": "mcpToolCall", "id": "call-1", "server": "alloy",
                "tool": "read_file", "status": "completed", "arguments": {"path": "notes/x.md"},
                "result": {"content": [{"type": "text", "text": "contents"}]}, "error": null
            }}
        });
        let result = app_server_tool_result(&completed, "thread", "turn").unwrap();
        assert_eq!(result.tool_use_id, "call-1");
        assert_eq!(result.content, "contents");
        assert_eq!(result.is_error, None);
    }

    #[test]
    fn parses_app_server_native_tool_events() {
        // Real codex-cli 0.147 app-server shapes. These are Codex-native tools,
        // not calls through Alloy's MCP server, but users should still see
        // their activity in the same thread pill stream.
        let command_started = json!({
            "method": "item/started",
            "params": {"threadId": "thread", "turnId": "turn", "item": {
                "type": "commandExecution", "id": "exec-1", "command": "/bin/zsh -lc pwd",
                "cwd": "/tmp", "status": "inProgress", "commandActions": []
            }}
        });
        let call = app_server_tool_use(&command_started, "thread", "turn").unwrap();
        assert_eq!(call.name, "command_execution");
        assert_eq!(call.input["command"], "/bin/zsh -lc pwd");

        let command_completed = json!({
            "method": "item/completed",
            "params": {"threadId": "thread", "turnId": "turn", "item": {
                "type": "commandExecution", "id": "exec-1", "command": "/bin/zsh -lc pwd",
                "cwd": "/tmp", "status": "completed", "commandActions": [],
                "aggregatedOutput": "/private/tmp\n", "exitCode": 0
            }}
        });
        let result = app_server_tool_result(&command_completed, "thread", "turn").unwrap();
        assert_eq!(result.content, "/private/tmp\n");
        assert_eq!(result.is_error, None);

        let web_started = json!({
            "method": "item/started",
            "params": {"threadId": "thread", "turnId": "turn", "item": {
                "type": "webSearch", "id": "search-1", "query": "", "action": null, "results": null
            }}
        });
        let started_call = app_server_tool_use(&web_started, "thread", "turn").unwrap();
        assert_eq!(started_call.name, "web_search");
        assert_eq!(started_call.input, json!({}));

        let web_completed = json!({
            "method": "item/completed",
            "params": {"threadId": "thread", "turnId": "turn", "item": {
                "type": "webSearch", "id": "search-1", "query": "Alloy",
                "action": {"type": "search", "query": "Alloy"},
                "results": [{"type": "text_result"}, {"type": "text_result"}]
            }}
        });
        let updated_call = app_server_tool_update(&web_completed, "thread", "turn").unwrap();
        assert_eq!(updated_call.id, "search-1");
        assert_eq!(updated_call.input, json!({"query": "Alloy"}));

        let result = app_server_tool_result(&web_completed, "thread", "turn").unwrap();
        assert_eq!(result.content, "Found 2 result(s)");
        assert_eq!(result.is_error, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn title_generation_uses_account_default_without_a_model_flag() {
        let script = r#"#!/bin/sh
printf '%s\n' "$@" > "$(dirname "$0")/args"
cat >/dev/null
echo '{"type":"agent_message","text":"**Codex Conversation Naming**"}'
"#;
        let (provider, dir) = scripted_provider(script);
        let title_model = provider.title_model("gpt-account-model");
        let title = provider
            .generate_title("why is naming broken?", "Here is the cause.", &title_model)
            .await;

        assert_eq!(title_model, "default");
        assert_eq!(title, "Codex Conversation Naming");
        let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
        assert!(!args.lines().any(|arg| arg == "--model"), "{args}");
        assert!(!args.contains("anthropic"), "{args}");
    }

    // Real codex-cli 0.145 output for a successful exec turn (the one-shot
    // fallback still parses its final message; interactive usage comes from
    // app-server notifications above).
    #[test]
    fn parses_agent_message_from_real_exec_output() {
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
            Some(
                "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."
            )
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

    #[cfg(unix)]
    #[tokio::test]
    async fn streams_app_server_deltas_and_usage() {
        let script = r#"#!/bin/sh
read init
echo '{"id":1,"result":{}}'
read initialized
read thread
echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read turn
echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"msg-1","delta":"Hello"}}'
echo '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"msg-1","delta":" world"}}'
echo '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":12,"outputTokens":2}}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","error":null,"items":[{"type":"agentMessage","text":"Hello world"}]}}}'
"#;
        let (provider, _dir) = scripted_provider(script);
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (delta_tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel();

        let result = provider
            .stream(stream_request(vec![user("hi")], cancel_rx, delta_tx))
            .await
            .unwrap();

        assert_eq!(result.content, "Hello world");
        assert_eq!(result.stop_reason, "end_turn");
        assert_eq!(result.usage.as_ref().map(|u| u.input_tokens), Some(12));
        assert_eq!(result.usage.as_ref().map(|u| u.output_tokens), Some(2));
        let mut deltas = Vec::new();
        while let Ok(event) = delta_rx.try_recv() {
            if let ProviderStreamEvent::Content(text) = event {
                deltas.push(text);
            }
        }
        assert_eq!(deltas, vec!["Hello", " world"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interrupts_an_active_app_server_turn() {
        let script = r#"#!/bin/sh
read init
echo '{"id":1,"result":{}}'
read initialized
read thread
echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read turn
echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"msg-1","delta":"Partial"}}'
read interrupt
echo '{"id":4,"result":{}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"interrupted","error":null,"items":[]}}}'
"#;
        let (provider, _dir) = scripted_provider(script);
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (delta_tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            provider
                .stream(stream_request(
                    vec![user("long answer")],
                    cancel_rx,
                    delta_tx,
                ))
                .await
        });

        let first = tokio::time::timeout(Duration::from_secs(3), delta_rx.recv())
            .await
            .expect("first delta timeout")
            .expect("first delta");
        assert_eq!(first, ProviderStreamEvent::Content("Partial".into()));
        cancel_tx.send(true).unwrap();

        let result = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("cancellation timeout")
            .expect("provider task")
            .unwrap();
        assert_eq!(result.stop_reason, "cancelled");
        assert_eq!(result.content, "Partial");
    }

    #[test]
    fn resolve_codex_binary_prefers_explicit_config() {
        assert_eq!(resolve_codex_binary(Some("/custom/codex")), "/custom/codex");
        assert_ne!(resolve_codex_binary(Some("")), "");
    }
}
