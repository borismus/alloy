//! Tool execution loop. Server-side port of the `executeWithTools` function
//! in [src/services/tools/executor.ts](src/services/tools/executor.ts):
//!
//! 1. Call provider.stream() with the current messages + tools.
//! 2. If the response is plain text (stop_reason != "tool_use"), return it.
//! 3. Otherwise, append the assistant turn (with tool_calls) + execute each
//!    tool + append tool results, then loop.
//! 4. Cap iterations to prevent runaway loops.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use crate::execution_policy::ExecutionPolicy;
use crate::providers::{
    ChatMessage, McpBridge, Provider, ProviderStreamEvent, StreamRequest, StreamResult, Usage,
};
use crate::tools::{ToolContext, ToolRegistry};
use crate::turn_budget::TokenLedger;
use crate::types::{ToolCall, ToolDefinition, ToolEventSink};

/// Stop reason for a turn that stopped gathering because it filled its context
/// budget and was made to conclude. The answer is real, but it rests on partial
/// evidence, so it is persisted and labelled rather than presented as a normal
/// completion.
pub const STOP_REASON_CONTEXT_BUDGET: &str = "context_budget";

/// Stop reason for a turn that reached the independent tool-round safety cap.
/// Context budgeting bounds prompt size, but not elapsed time, cost, repeated
/// side effects, models with unknown windows, or currently unbudgeted subagents.
pub const STOP_REASON_ITERATION_LIMIT: &str = "iteration_limit";

/// Told to the model when a tool-using turn produced no prose (see the forced
/// wrap-up below). Dropping `tools` from the request is not enough on its own:
/// the model is mid-pattern (assistant tool_call → tool result → repeat) and
/// has no way to know its tool budget is gone, so it just emits another tool
/// call and returns empty content. Measured against gemini-3.5-flash,
/// claude-sonnet-4.6, gpt-5.4-nano and a local MLX model: without this, three
/// of the four return a completely blank turn when the tool results don't
/// contain the answer; with it, all four answer or say what's missing, and
/// none of them lose accuracy when the results *were* sufficient.
///
/// This is ephemeral: it is appended to a clone of the send view for this one
/// call, so it never reaches the vault or any later turn.
const WRAP_UP_INSTRUCTION: &str = concat!(
    "Stop using tools. You have no tools available for this reply. ",
    "Using ONLY what you already found above, write the final answer now in plain text. ",
    "If something required is missing, say exactly what is missing and what you need from the user.",
);

/// Tools whose result is a pure function of their arguments for the duration of
/// one turn, so running the identical call twice can only burn context and time.
/// Everything else — writes, task mutations, sub-agents — must always execute:
/// suppressing a repeated write would silently drop the user's second edit, and
/// a sub-agent's answer is not reproducible from its prompt.
fn is_repeatable_read(name: &str) -> bool {
    matches!(
        name,
        "web_search"
            | "web_fetch"
            | "http_get"
            | "read_file"
            | "list_directory"
            | "search_directory"
            | "use_skill"
    )
}

/// Identity of a tool call for duplicate detection. `serde_json`'s maps are
/// key-sorted (the `preserve_order` feature is off), so two calls that differ
/// only in argument order produce the same key.
fn call_signature(call: &ToolCall) -> String {
    format!(
        "{}\u{1f}{}",
        call.name,
        serde_json::to_string(&call.input).unwrap_or_default()
    )
}

pub struct LoopRequest {
    pub provider: Arc<dyn Provider>,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub delta_tx: mpsc::UnboundedSender<ProviderStreamEvent>,
    pub cancel: watch::Receiver<bool>,
    /// Task executions retry only pre-response connection establishment.
    pub retry_connect: bool,
    pub tool_ctx: ToolContext,
    /// MCP bridge coordinates for the Claude Code provider (see `McpBridge`).
    pub mcp: Option<McpBridge>,
    /// Context window of the selected model, when discovery knows it. Drives the
    /// per-turn budget; `None` disables budgeting rather than inventing a limit.
    pub context_window: Option<u64>,
    /// Resolved limits for this turn. Interactive and task callers use distinct
    /// policies; HTTP request bodies cannot set this value.
    pub execution_policy: ExecutionPolicy,
}

pub async fn execute_with_tools(
    req: LoopRequest,
    registry: Arc<ToolRegistry>,
    sink: Arc<dyn ToolEventSink>,
) -> anyhow::Result<StreamResult> {
    let LoopRequest {
        provider,
        model,
        mut messages,
        tools,
        delta_tx,
        cancel,
        retry_connect,
        tool_ctx,
        mcp,
        context_window,
        execution_policy,
    } = req;

    let mut total_input: u32 = 0;
    let mut total_output: u32 = 0;
    let mut total_connection_retries: u32 = 0;
    let mut first_response_id: Option<String> = None;
    let mut final_content = String::new();
    let mut final_stop_reason = "end_turn".to_string();
    let mut web_search_count: u32 = 0;
    // Whether any tool ran this turn. Used to decide if a blank final result
    // warrants a forced wrap-up call (see below). A turn with no tool calls
    // that legitimately produced no text is left alone.
    let mut any_tool_executed = false;

    let mut ledger = TokenLedger::with_output_limit(
        context_window,
        &tools,
        execution_policy.max_output_tokens,
    );
    // Signature -> the 1-based call number that already produced this exact
    // result, so a repeat can point the model at evidence it already has.
    let mut completed_reads: HashMap<String, usize> = HashMap::new();
    let mut executed_calls: usize = 0;
    let mut duplicate_calls: usize = 0;
    // Set when the turn must stop gathering and write its conclusion, either
    // because the budget is spent or because a result would not fit at all.
    let mut budget_exhausted = false;
    // Independent runaway-loop backstop. Token budgeting cannot replace this:
    // unknown windows are deliberately unbudgeted, and many tiny tool rounds can
    // consume substantial time or repeat side effects without filling a window.
    let mut iteration_limit_reached = false;

    for iteration in 0..execution_policy.max_iterations {
        if *cancel.borrow() {
            break;
        }

        // A conversation that cannot fit before a single tool has run will never
        // fit; fail here rather than after minutes of generation and an upstream
        // rejection. Once evidence exists we instead wrap up with what we have.
        if ledger.over_hard_limit(&messages) {
            if !any_tool_executed {
                let budget = ledger.budget().expect("limit implies a budget");
                anyhow::bail!(
                    "This turn needs about {} tokens, but only {} of {}'s {}-token context \
                     window are usable. Shorten the request, or switch to a model with a \
                     larger context window.",
                    ledger.projected(&messages),
                    budget.hard_limit,
                    model,
                    budget.window,
                );
            }
            budget_exhausted = true;
        }
        if !budget_exhausted && any_tool_executed && ledger.over_soft_limit(&messages) {
            budget_exhausted = true;
        }
        if budget_exhausted {
            tracing::info!(
                iteration,
                projected_tokens = ledger.projected(&messages),
                executed_calls,
                duplicate_calls,
                "turn budget spent; forcing a conclusion"
            );
            break;
        }

        // Taken before the call so reported usage can be compared against the
        // estimate of the very prompt that produced it.
        let estimate_at_send = ledger.raw_estimate(&messages);

        let req = StreamRequest {
            messages: messages.clone(),
            model: model.clone(),
            tools: tools.clone(),
            delta_tx: delta_tx.clone(),
            cancel: cancel.clone(),
            retry_connect,
            tool_sink: sink.clone(),
            mcp: mcp.clone(),
            execution_policy,
        };
        let result = provider.stream(req).await?;

        if let Some(usage) = &result.usage {
            total_input += usage.input_tokens;
            total_output += usage.output_tokens;
            total_connection_retries += usage.connection_retries;
            if first_response_id.is_none() {
                first_response_id = usage.response_id.clone();
            }
            ledger.calibrate(estimate_at_send, usage.input_tokens);
        }
        // Accumulate — do NOT overwrite. The model often emits its answer text
        // in the same turn as a tool call and then a final empty tool-only/
        // closing turn; overwriting here would replace the answer with that
        // empty turn's content (the message saves blank even though the text
        // was streamed). Accumulating mirrors exactly what the client received
        // via delta_tx, so the persisted content matches what was shown.
        final_content.push_str(&result.content);
        final_stop_reason = result.stop_reason.clone();

        if result.stop_reason != "tool_use" || result.tool_calls.is_empty() {
            break;
        }

        // Append assistant turn (text + tool calls) to history.
        messages.push(ChatMessage::assistant_from_result(
            result.content.clone(),
            &result.tool_calls,
        ));

        // Execute each tool sequentially. (Parallel would be faster but
        // sequential matches the SPA's behavior and avoids interleaved
        // tool_use events confusing the UI.)
        for call in &result.tool_calls {
            // Enforce the per-turn web_search budget *before* surfacing the
            // call to the UI. A model (e.g. Gemini) can emit many web_search
            // calls in one parallel batch; once the budget is spent, the extra
            // ones are neither executed nor shown as pills. We still append an
            // error tool_result so the model is told to stop searching and
            // every tool_use keeps its matching tool_result (providers require
            // the pairing).
            if call.name == "web_search" {
                web_search_count += 1;
                if web_search_count > execution_policy.max_web_searches {
                    messages.push(ChatMessage::tool_result(
                        call.id.clone(),
                        format!(
                            "Web search budget exhausted ({} searches this turn). \
                             Do not search again — answer using the results you already have.",
                            execution_policy.max_web_searches
                        ),
                    ));
                    continue;
                }
            }

            // Suppress an exact repeat of a read this turn already performed.
            // Nothing runs and no pill is emitted — the earlier result is still
            // in `messages`, so the model is pointed back at evidence it has
            // rather than paying for the same bytes a second time.
            let signature = is_repeatable_read(&call.name).then(|| call_signature(call));
            if let Some(previous) = signature.as_ref().and_then(|key| completed_reads.get(key)) {
                duplicate_calls += 1;
                messages.push(ChatMessage::tool_result(
                    call.id.clone(),
                    format!(
                        "Duplicate call: `{}` already ran with these exact arguments earlier in \
                         this turn (tool call #{}). Its result is already above — reuse it \
                         instead of calling it again.",
                        call.name, previous
                    ),
                ));
                continue;
            }

            // Don't spend time fetching a result that cannot fit in the window.
            if budget_exhausted {
                messages.push(ChatMessage::tool_result(
                    call.id.clone(),
                    "Context budget for this turn is exhausted, so this tool was not run. \
                     Write your final answer now from the evidence already gathered."
                        .into(),
                ));
                continue;
            }

            sink.on_tool_use(call);
            let tool_result = registry.execute(call, &tool_ctx).await;
            sink.on_tool_result(&tool_result);
            let failed = tool_result.is_error.unwrap_or(false);
            messages.push(ChatMessage::tool_result(
                tool_result.tool_use_id.clone(),
                tool_result.content.clone(),
            ));
            any_tool_executed = true;
            executed_calls += 1;
            // Only successful reads are memoized — a transient failure has to
            // stay retryable within the same turn.
            if let Some(signature) = signature {
                if !failed {
                    completed_reads.insert(signature, executed_calls);
                }
            }
            // Re-check inside the round: a single batch of parallel calls can
            // add tens of thousands of tokens, so waiting for the next iteration
            // would let the turn sail past the limit it is meant to respect.
            if ledger.over_soft_limit(&messages) {
                budget_exhausted = true;
            }
        }

        // Separator between tool-call rounds in streamed text — matches the
        // " " space the SPA emits in [src/services/tools/executor.ts:389].
        // Mirror it into final_content too so the saved text stays identical
        // to what was streamed.
        let _ = delta_tx.send(ProviderStreamEvent::Content(" ".into()));
        final_content.push(' ');

        tracing::debug!(
            iteration,
            projected_tokens = ledger.projected(&messages),
            executed_calls,
            duplicate_calls,
            "tool loop iteration complete"
        );

        if budget_exhausted {
            break;
        }
        if iteration + 1 == execution_policy.max_iterations {
            iteration_limit_reached = true;
            tracing::warn!(
                iteration,
                projected_tokens = ledger.projected(&messages),
                executed_calls,
                duplicate_calls,
                "tool-round safety limit reached; forcing a conclusion"
            );
        }
    }

    // Forced wrap-up. Three situations need one more, tool-free call:
    //
    // 1. The model used tools but never emitted any text — some providers (e.g.
    //    Gemini) emit tool calls with no narration and expect to answer at the
    //    end. The persisted message would be empty and the conversation would
    //    appear to stall.
    // 2. The context budget ran out, so the loop stopped gathering evidence.
    // 3. The independent tool-round safety cap was reached. The model may have
    //    narrated its progress in both cases, and saving that narration as the
    //    answer would persist a mid-plan sentence as if it were a conclusion.
    //
    // Dropping `tools` is not enough on its own, hence WRAP_UP_INSTRUCTION. A
    // turn that finished on its own is never affected (see
    // `nonblank_turn_skips_wrap_up`).
    let needs_wrap_up = !*cancel.borrow()
        && ((final_content.trim().is_empty() && any_tool_executed)
            || budget_exhausted
            || iteration_limit_reached);
    if needs_wrap_up {
        let mut wrap_up_messages = messages.clone();
        wrap_up_messages.push(ChatMessage::User {
            content: WRAP_UP_INSTRUCTION.to_string(),
            images: Vec::new(),
        });
        // Last guard before the wire. If even a tool-free conclusion doesn't
        // fit, fail here: the alternative is a multi-minute wait for the
        // provider to reject the prompt, with nothing to show for it. The
        // partial content and tool history are still persisted by the caller.
        if ledger.over_hard_limit(&wrap_up_messages) {
            let budget = ledger.budget().expect("limit implies a budget");
            anyhow::bail!(
                "This turn gathered about {} tokens of material, more than the {} usable from \
                 {}'s {}-token context window, so there was no room left to write an answer. \
                 Narrow the request, or switch to a model with a larger context window.",
                ledger.projected(&wrap_up_messages),
                budget.hard_limit,
                model,
                budget.window,
            );
        }
        let req = StreamRequest {
            messages: wrap_up_messages,
            model: model.clone(),
            tools: vec![],
            delta_tx: delta_tx.clone(),
            cancel: cancel.clone(),
            retry_connect,
            tool_sink: sink.clone(),
            mcp: mcp.clone(),
            execution_policy,
        };
        let wrap = provider.stream(req).await.map_err(|error| {
            anyhow::anyhow!(
                "model used tools but final answer generation failed: {}",
                error
            )
        })?;
        if wrap.content.trim().is_empty() {
            if budget_exhausted {
                anyhow::bail!(
                    "This turn reached its context limit, and the model produced no final \
                     answer when asked to conclude."
                );
            }
            if iteration_limit_reached {
                anyhow::bail!(
                    "This turn reached its tool-use safety limit, and the model produced no \
                     final answer when asked to conclude."
                );
            }
            anyhow::bail!(
                "model used tools but returned no final text, including after a tool-free wrap-up"
            );
        }
        if let Some(usage) = &wrap.usage {
            total_input += usage.input_tokens;
            total_output += usage.output_tokens;
            total_connection_retries += usage.connection_retries;
            if first_response_id.is_none() {
                first_response_id = usage.response_id.clone();
            }
        }
        final_content.push_str(&wrap.content);
        // The wrap-up call's own stop reason describes that one request, not the
        // turn. When the budget cut the turn short, say so: the caller persists
        // this and the UI tells the user the answer is based on partial work.
        final_stop_reason = if budget_exhausted {
            STOP_REASON_CONTEXT_BUDGET.to_string()
        } else if iteration_limit_reached {
            STOP_REASON_ITERATION_LIMIT.to_string()
        } else {
            wrap.stop_reason
        };
    }

    let usage = if total_input > 0 || total_output > 0 || total_connection_retries > 0 {
        Some(Usage {
            input_tokens: total_input,
            output_tokens: total_output,
            response_id: first_response_id,
            cost: None,
            duration_ms: None,
            connection_retries: total_connection_retries,
        })
    } else {
        None
    };

    Ok(StreamResult {
        content: final_content.trim().to_string(),
        usage,
        stop_reason: final_stop_reason,
        tool_calls: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::providers::ProviderRegistry;
    use crate::skill_registry::SkillRegistry;
    use crate::types::{NullSink, ToolCall, ToolResult};
    use crate::vault::Vault;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    const MAX_ITERATIONS: u32 = crate::execution_policy::INTERACTIVE_MAX_ITERATIONS;

    /// Provider that replays a fixed script of `StreamResult`s, one per
    /// `stream()` call — lets us simulate a multi-turn agentic exchange.
    struct ScriptedProvider {
        steps: Mutex<VecDeque<StreamResult>>,
        /// Messages seen by each `stream()` call, so tests can assert what the
        /// loop actually sent (not just what it returned).
        seen: Mutex<Vec<Vec<ChatMessage>>>,
    }

    impl ScriptedProvider {
        fn new(steps: Vec<StreamResult>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl Provider for ScriptedProvider {
        async fn stream(&self, req: StreamRequest) -> anyhow::Result<StreamResult> {
            self.seen.lock().unwrap().push(req.messages.clone());
            self.steps
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| anyhow::anyhow!("scripted provider exhausted"))
        }
        async fn generate_title(&self, _u: &str, _a: &str, _m: &str) -> String {
            String::new()
        }
    }

    fn usage(out: u32) -> Option<Usage> {
        Some(Usage {
            input_tokens: 1,
            output_tokens: out,
            response_id: None,
            cost: None,
            duration_ms: None,
            connection_retries: 0,
        })
    }

    /// A turn that emits `text` and then calls a tool. The tool is unregistered
    /// on purpose: `registry.execute` returns an error result with no network/IO,
    /// which is all this loop test needs (the model's behavior is scripted).
    fn tool_turn(text: &str, out: u32) -> StreamResult {
        StreamResult {
            content: text.into(),
            usage: usage(out),
            stop_reason: "tool_use".into(),
            tool_calls: vec![ToolCall {
                id: "t1".into(),
                name: "noop".into(),
                input: json!({}),
            }],
        }
    }

    fn final_turn(text: &str, out: u32) -> StreamResult {
        StreamResult {
            content: text.into(),
            usage: usage(out),
            stop_reason: "end_turn".into(),
            tool_calls: vec![],
        }
    }

    fn test_registry() -> Arc<ToolRegistry> {
        Arc::new(ToolRegistry::new(
            Arc::new(Config::default()),
            Arc::new(Vault::new(std::env::temp_dir()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ))
    }

    /// Records the tool calls that actually reached execution, so a test can
    /// tell a suppressed duplicate from a re-run.
    #[derive(Default)]
    struct RecordingSink {
        uses: Mutex<Vec<ToolCall>>,
    }

    impl ToolEventSink for RecordingSink {
        fn on_tool_use(&self, call: &ToolCall) {
            self.uses.lock().unwrap().push(call.clone());
        }
        fn on_tool_result(&self, _result: &ToolResult) {}
    }

    /// A vault with real notes, for tests that need tools that genuinely run.
    fn vault_registry() -> (Arc<ToolRegistry>, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("alloy-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "alpha body").unwrap();
        std::fs::write(root.join("notes/b.md"), "beta body").unwrap();
        let registry = Arc::new(ToolRegistry::new(
            Arc::new(Config::default()),
            Arc::new(Vault::new(root.clone()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ));
        (registry, root)
    }

    struct LoopCase {
        steps: Vec<StreamResult>,
        messages: Vec<ChatMessage>,
        context_window: Option<u64>,
        registry: Arc<ToolRegistry>,
        sink: Arc<dyn ToolEventSink>,
        cancelled: bool,
        execution_policy: ExecutionPolicy,
    }

    impl LoopCase {
        fn new(steps: Vec<StreamResult>) -> Self {
            Self {
                steps,
                messages: vec![],
                context_window: None,
                registry: test_registry(),
                sink: Arc::new(NullSink),
                cancelled: false,
                execution_policy: ExecutionPolicy::interactive(),
            }
        }

        async fn run(self) -> (anyhow::Result<StreamResult>, Arc<ScriptedProvider>) {
            let provider = Arc::new(ScriptedProvider::new(self.steps));
            let (delta_tx, _rx) = mpsc::unbounded_channel();
            let (_cancel_tx, cancel) = watch::channel(self.cancelled);
            let req = LoopRequest {
                provider: provider.clone(),
                model: "test/model".into(),
                messages: self.messages,
                tools: vec![],
                delta_tx,
                cancel,
                retry_connect: false,
                tool_ctx: ToolContext {
                    message_id: None,
                    conversation_id: None,
                    inside_subagent: false,
                    model_is_local: false,
                    execution_policy: self.execution_policy,
                },
                mcp: None,
                context_window: self.context_window,
                execution_policy: self.execution_policy,
            };
            let result = execute_with_tools(req, self.registry, self.sink).await;
            (result, provider)
        }
    }

    /// Run the loop and also hand back the provider, so a test can inspect the
    /// requests the loop made.
    async fn run_capturing(
        steps: Vec<StreamResult>,
    ) -> (anyhow::Result<StreamResult>, Arc<ScriptedProvider>) {
        LoopCase::new(steps).run().await
    }

    /// Every `ChatMessage::User` body the provider was sent, flattened.
    fn user_texts(provider: &ScriptedProvider) -> Vec<String> {
        provider
            .seen
            .lock()
            .unwrap()
            .iter()
            .flatten()
            .filter_map(|m| match m {
                ChatMessage::User { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect()
    }

    async fn run_result(steps: Vec<StreamResult>) -> anyhow::Result<StreamResult> {
        LoopCase::new(steps).run().await.0
    }

    async fn run(steps: Vec<StreamResult>) -> StreamResult {
        run_result(steps).await.unwrap()
    }

    /// Regression: the model emits its answer in the same turn as a tool call,
    /// then closes with an empty turn. The empty turn must NOT wipe the answer
    /// (the bug: `final_content` was overwritten each iteration, so the saved
    /// message came back blank despite the text having been streamed).
    #[tokio::test]
    async fn answer_in_a_tool_turn_survives_an_empty_closing_turn() {
        let result = run(vec![
            tool_turn("Here is the answer.", 1000),
            final_turn("", 20),
        ])
        .await;
        assert_eq!(result.content, "Here is the answer.");
        // Usage accumulates across every model call in the turn.
        assert_eq!(result.usage.unwrap().output_tokens, 1020);
    }

    /// Text from multiple turns is concatenated — matching what gets streamed to
    /// the client — joined by the same " " round separator the loop emits.
    #[tokio::test]
    async fn text_accumulates_across_turns() {
        let result = run(vec![
            tool_turn("Searching.", 5),
            final_turn("Final answer.", 30),
        ])
        .await;
        assert_eq!(result.content, "Searching. Final answer.");
    }

    /// Gemini-style: the model emits tool calls with NO narration and then a
    /// blank closing turn, so the loop ends empty. The forced wrap-up call (no
    /// tools) must run to produce a written answer instead of saving a blank
    /// message. Usage from the wrap-up call accumulates too.
    #[tokio::test]
    async fn blank_tool_turn_forces_a_wrap_up_answer() {
        let result = run(vec![
            tool_turn("", 100),
            final_turn("", 5),
            final_turn("Here is the answer.", 40),
        ])
        .await;
        assert_eq!(result.content, "Here is the answer.");
        assert_eq!(result.usage.unwrap().output_tokens, 145);
    }

    /// When the model never stops calling tools and the loop exhausts
    /// MAX_ITERATIONS, the wrap-up call still forces a final text answer.
    #[tokio::test]
    async fn iteration_cap_forces_a_wrap_up_answer() {
        let mut steps: Vec<StreamResult> = (0..MAX_ITERATIONS).map(|_| tool_turn("", 10)).collect();
        steps.push(final_turn("Wrapped up.", 20));
        let result = run(steps).await;
        assert_eq!(result.content, "Wrapped up.");
        assert_eq!(result.stop_reason, STOP_REASON_ITERATION_LIMIT);
    }

    /// Regression: narration is not a conclusion. The historical failure ended
    /// with "Several strong candidates. Reading the most promising ones now."
    /// at the cap and saved it as an ordinary complete answer because only a
    /// *blank* capped turn triggered wrap-up.
    #[tokio::test]
    async fn narrated_iteration_cap_still_wraps_up_and_is_labelled() {
        let mut steps: Vec<StreamResult> = (0..MAX_ITERATIONS)
            .map(|_| tool_turn("Several strong candidates. Reading them now.", 10))
            .collect();
        steps.push(final_turn("Here is the conclusion from the evidence gathered.", 20));

        let (result, provider) = run_capturing(steps).await;
        let result = result.unwrap();
        assert!(result.content.ends_with("Here is the conclusion from the evidence gathered."));
        assert_eq!(result.stop_reason, STOP_REASON_ITERATION_LIMIT);
        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen.len(), MAX_ITERATIONS as usize + 1);
        assert!(matches!(
            seen.last().unwrap().last(),
            Some(ChatMessage::User { content, images })
                if content == WRAP_UP_INSTRUCTION && images.is_empty()
        ));
    }

    #[tokio::test]
    async fn task_policy_can_finish_after_the_old_interactive_cap() {
        let rounds = ExecutionPolicy::interactive().max_iterations + 2;
        let mut steps: Vec<StreamResult> = (0..rounds).map(|_| tool_turn("", 10)).collect();
        steps.push(final_turn("Full task report.", 20));
        let (result, provider) = LoopCase {
            execution_policy: ExecutionPolicy::task(&Default::default(), None),
            ..LoopCase::new(steps)
        }
        .run()
        .await;

        let result = result.unwrap();
        assert_eq!(result.content, "Full task report.");
        assert_eq!(result.stop_reason, "end_turn");
        assert_eq!(provider.seen.lock().unwrap().len(), rounds as usize + 1);
    }

    #[tokio::test]
    async fn iteration_cap_with_a_blank_wrap_up_is_an_error() {
        let mut steps: Vec<StreamResult> = (0..MAX_ITERATIONS).map(|_| tool_turn("", 10)).collect();
        steps.push(final_turn("   ", 20));
        let error = run_result(steps).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "This turn reached its tool-use safety limit, and the model produced no final answer \
             when asked to conclude."
        );
    }

    #[tokio::test]
    async fn cancellation_does_not_call_the_provider_or_force_a_wrap_up() {
        let mut case = LoopCase::new(vec![final_turn("Must not be sent.", 10)]);
        case.cancelled = true;
        let (result, provider) = case.run().await;
        let result = result.unwrap();
        assert!(result.content.is_empty());
        assert_eq!(result.stop_reason, "end_turn");
        assert!(provider.seen.lock().unwrap().is_empty());
    }

    /// Regression: a tool-using turn that stays blank even after the no-tools
    /// wrap-up must enter the stream error path. Returning Ok here persists an
    /// empty assistant message and makes a completed turn look stuck.
    #[tokio::test]
    async fn blank_wrap_up_is_an_error() {
        let error = run_result(vec![
            tool_turn("", 100),
            final_turn("", 5),
            final_turn("   ", 40),
        ])
        .await
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "model used tools but returned no final text, including after a tool-free wrap-up"
        );
    }

    /// Dropping `tools` is not enough for every model: mid-pattern it just
    /// emits another tool call and returns nothing. The wrap-up must SAY the
    /// tool phase is over, and only on the wrap-up call.
    #[tokio::test]
    async fn wrap_up_tells_the_model_the_tool_phase_is_over() {
        let (result, provider) = run_capturing(vec![
            tool_turn("", 100),
            final_turn("", 5),
            final_turn("Here is the answer.", 40),
        ])
        .await;
        assert_eq!(result.unwrap().content, "Here is the answer.");

        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "two loop turns plus one wrap-up");
        // The wrap-up carries the instruction and no tools...
        assert!(
            matches!(seen[2].last(), Some(ChatMessage::User { content, .. })
                if content == WRAP_UP_INSTRUCTION),
            "wrap-up must end with the instruction, got: {:?}",
            seen[2].last()
        );
        // ...and the ordinary loop turns are left completely untouched.
        drop(seen);
        let instructions = user_texts(&provider)
            .into_iter()
            .filter(|t| t == WRAP_UP_INSTRUCTION)
            .count();
        assert_eq!(
            instructions, 1,
            "instruction must not leak into other turns"
        );
    }

    /// A normal turn never sees the instruction, because the wrap-up never runs.
    #[tokio::test]
    async fn nonblank_turn_never_sees_the_wrap_up_instruction() {
        let (result, provider) =
            run_capturing(vec![tool_turn("Looking.", 5), final_turn("Answer.", 10)]).await;
        assert_eq!(result.unwrap().content, "Looking. Answer.");
        assert!(
            !user_texts(&provider)
                .iter()
                .any(|t| t == WRAP_UP_INSTRUCTION),
            "a turn that produced prose must be sent exactly as-is"
        );
    }

    /// A failed final-answer request must retain its cause in the stream error
    /// that the conversation layer persists.
    #[tokio::test]
    async fn failed_wrap_up_is_an_error() {
        let error = run_result(vec![tool_turn("", 100), final_turn("", 5)])
            .await
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "model used tools but final answer generation failed: scripted provider exhausted"
        );
    }

    /// Regression: a turn that produces text normally must NOT trigger an extra
    /// wrap-up call. The script holds exactly the expected number of turns;
    /// an extra call would return an error and fail `run()`.
    #[tokio::test]
    async fn nonblank_turn_skips_wrap_up() {
        let result = run(vec![tool_turn("Looking.", 5), final_turn("Answer.", 10)]).await;
        assert_eq!(result.content, "Looking. Answer.");
    }

    /// A turn that calls one tool per round with the given argument.
    fn read_turn(id: &str, path: &str) -> StreamResult {
        StreamResult {
            content: String::new(),
            usage: usage(1),
            stop_reason: "tool_use".into(),
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: "read_file".into(),
                input: json!({ "path": path }),
            }],
        }
    }

    fn tool_results(provider: &ScriptedProvider) -> Vec<String> {
        provider
            .seen
            .lock()
            .unwrap()
            .iter()
            .flatten()
            .filter_map(|m| match m {
                ChatMessage::Tool { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect()
    }

    /// The observed overflow turn re-ran searches and reads it had already done.
    /// An identical read must execute once and send the model back to the result
    /// it already has, instead of paying for the same bytes again.
    #[tokio::test]
    async fn an_identical_read_runs_once_and_points_back_at_the_first_result() {
        let (registry, root) = vault_registry();
        let sink = Arc::new(RecordingSink::default());
        let (result, provider) = LoopCase {
            registry,
            sink: sink.clone(),
            ..LoopCase::new(vec![
                read_turn("t1", "notes/a.md"),
                read_turn("t2", "notes/a.md"),
                final_turn("Done.", 5),
            ])
        }
        .run()
        .await;
        assert_eq!(result.unwrap().content, "Done.");

        assert_eq!(
            sink.uses.lock().unwrap().len(),
            1,
            "the repeat must not reach the tool"
        );
        let results = tool_results(&provider);
        assert!(
            results.iter().any(|r| r.contains("alpha body")),
            "first read returns real content: {results:?}"
        );
        let duplicate = results
            .iter()
            .find(|r| r.contains("Duplicate call"))
            .expect("repeat is answered with a reference");
        assert!(duplicate.contains("tool call #1"), "got: {duplicate}");
        // Every tool_use still has a matching tool_result: providers reject an
        // unpaired call, so suppression must never skip the reply.
        assert!(!duplicate.contains("alpha body"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Suppression keys on the arguments, so different reads still run — and
    /// argument order must not create a false miss.
    #[tokio::test]
    async fn different_reads_still_execute() {
        let (registry, root) = vault_registry();
        let sink = Arc::new(RecordingSink::default());
        let (result, _) = LoopCase {
            registry,
            sink: sink.clone(),
            ..LoopCase::new(vec![
                read_turn("t1", "notes/a.md"),
                read_turn("t2", "notes/b.md"),
                final_turn("Done.", 5),
            ])
        }
        .run()
        .await;
        assert!(result.is_ok());
        assert_eq!(sink.uses.lock().unwrap().len(), 2);

        assert_eq!(
            call_signature(&ToolCall {
                id: "a".into(),
                name: "read_file".into(),
                input: json!({ "path": "x", "limit": 1 }),
            }),
            call_signature(&ToolCall {
                id: "b".into(),
                name: "read_file".into(),
                input: json!({ "limit": 1, "path": "x" }),
            }),
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Writes and other side-effecting tools must always run: suppressing a
    /// repeated append would silently drop the user's second edit.
    #[tokio::test]
    async fn repeated_writes_are_never_suppressed() {
        let (registry, root) = vault_registry();
        let sink = Arc::new(RecordingSink::default());
        let append = |id: &str| StreamResult {
            content: String::new(),
            usage: usage(1),
            stop_reason: "tool_use".into(),
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: "append_to_note".into(),
                input: json!({ "path": "notes/a.md", "content": "same line" }),
            }],
        };
        let (result, provider) = LoopCase {
            registry,
            sink: sink.clone(),
            ..LoopCase::new(vec![append("t1"), append("t2"), final_turn("Done.", 5)])
        }
        .run()
        .await;
        assert!(result.is_ok());
        assert_eq!(
            sink.uses.lock().unwrap().len(),
            2,
            "both writes must execute"
        );
        assert!(!tool_results(&provider)
            .iter()
            .any(|r| r.contains("Duplicate call")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Evidence keeps accumulating until it approaches the window. The loop must
    /// stop gathering while a conclusion still fits, rather than continuing to
    /// MAX_ITERATIONS and overflowing.
    #[tokio::test]
    async fn a_spent_budget_stops_gathering_and_forces_a_conclusion() {
        // 20k window -> ~14k usable, soft limit ~11.2k. One round of narration
        // worth ~12k tokens lands between the two.
        let (result, provider) = LoopCase {
            context_window: Some(20_000),
            ..LoopCase::new(vec![
                tool_turn(&"x".repeat(48_000), 10),
                final_turn("Conclusion.", 20),
            ])
        }
        .run()
        .await;

        let result = result.unwrap();
        assert!(
            result.content.ends_with("Conclusion."),
            "conclusion is appended"
        );
        assert!(result.content.contains("xxx"), "narration is preserved");
        // Labelled, so the UI can say the answer rests on partial evidence
        // instead of presenting it as an ordinary completion.
        assert_eq!(result.stop_reason, STOP_REASON_CONTEXT_BUDGET);

        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "one gathering round, then the wrap-up");
        assert!(
            matches!(seen[1].last(), Some(ChatMessage::User { content, .. })
                if content == WRAP_UP_INSTRUCTION),
            "the forced conclusion carries the tool-free instruction"
        );
    }

    /// The real failure: a prompt far past the window was sent anyway and came
    /// back as an upstream 400 after minutes. It must fail here, before the
    /// wire, with the partial work left for the caller to persist.
    #[tokio::test]
    async fn evidence_past_the_window_fails_locally_instead_of_being_sent() {
        let (result, provider) = LoopCase {
            context_window: Some(20_000),
            ..LoopCase::new(vec![
                tool_turn(&"x".repeat(80_000), 10),
                final_turn("never reached", 20),
            ])
        }
        .run()
        .await;

        let error = result.unwrap_err().to_string();
        assert!(error.contains("20000-token context window"), "got: {error}");
        assert!(
            error.contains("no room left to write an answer"),
            "got: {error}"
        );
        assert_eq!(
            provider.seen.lock().unwrap().len(),
            1,
            "the oversized prompt must never reach the provider"
        );
    }

    /// A conversation that cannot fit before any tool has run will never fit.
    /// Say so immediately rather than after a long generation.
    #[tokio::test]
    async fn an_oversized_conversation_fails_before_the_first_call() {
        let (result, provider) = LoopCase {
            context_window: Some(20_000),
            messages: vec![ChatMessage::User {
                content: "x".repeat(200_000),
                images: vec![],
            }],
            ..LoopCase::new(vec![final_turn("never reached", 5)])
        }
        .run()
        .await;

        let error = result.unwrap_err().to_string();
        assert!(error.contains("larger context window"), "got: {error}");
        assert!(
            provider.seen.lock().unwrap().is_empty(),
            "nothing is sent when the request cannot fit"
        );
    }

    /// Budgeting must be invisible to ordinary turns: same calls, same text, no
    /// extra wrap-up. The script holds exactly two turns, so a third call fails.
    #[tokio::test]
    async fn a_known_window_leaves_an_ordinary_turn_untouched() {
        let (result, provider) = LoopCase {
            context_window: Some(262_144),
            ..LoopCase::new(vec![tool_turn("Looking.", 5), final_turn("Answer.", 10)])
        }
        .run()
        .await;
        let result = result.unwrap();
        assert_eq!(result.content, "Looking. Answer.");
        assert_eq!(provider.seen.lock().unwrap().len(), 2);
        // An ordinary turn must never be labelled as cut short.
        assert_ne!(result.stop_reason, STOP_REASON_CONTEXT_BUDGET);
    }
}
