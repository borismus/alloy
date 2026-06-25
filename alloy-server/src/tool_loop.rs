//! Tool execution loop. Server-side port of the `executeWithTools` function
//! in [src/services/tools/executor.ts](src/services/tools/executor.ts):
//!
//! 1. Call provider.stream() with the current messages + tools.
//! 2. If the response is plain text (stop_reason != "tool_use"), return it.
//! 3. Otherwise, append the assistant turn (with tool_calls) + execute each
//!    tool + append tool results, then loop.
//! 4. Cap iterations to prevent runaway loops.

use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use crate::providers::{
    ChatMessage, Provider, StreamRequest, StreamResult, Usage,
};
use crate::tools::{ToolContext, ToolRegistry};
use crate::types::{ToolCall, ToolDefinition, ToolResult};

/// Callback emitted by the loop for each tool invocation, so the streaming
/// session can fan it out to SSE subscribers as `tool_use` / `tool_result`
/// events that the SPA's `ToolUseIndicator` UI already understands.
pub trait ToolEventSink: Send + Sync {
    fn on_tool_use(&self, call: &ToolCall);
    fn on_tool_result(&self, result: &ToolResult);
}

pub struct NullSink;
impl ToolEventSink for NullSink {
    fn on_tool_use(&self, _: &ToolCall) {}
    fn on_tool_result(&self, _: &ToolResult) {}
}

const MAX_ITERATIONS: u32 = 10;

/// Per-turn cap on `web_search` calls. The model otherwise tends to fire off
/// far more searches than a question warrants; once this budget is spent, the
/// remaining calls short-circuit with an error result that tells the model to
/// answer from what it already has instead of burning more iterations.
const MAX_WEB_SEARCHES: u32 = 3;

pub struct LoopRequest {
    pub provider: Arc<dyn Provider>,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub chunk_tx: mpsc::UnboundedSender<String>,
    pub cancel: watch::Receiver<bool>,
    pub tool_ctx: ToolContext,
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
        chunk_tx,
        cancel,
        tool_ctx,
    } = req;

    let mut total_input: u32 = 0;
    let mut total_output: u32 = 0;
    let mut first_response_id: Option<String> = None;
    let mut final_content = String::new();
    let mut final_stop_reason = "end_turn".to_string();
    let mut web_search_count: u32 = 0;
    // Whether any tool ran this turn. Used to decide if a blank final result
    // warrants a forced wrap-up call (see below). A turn with no tool calls
    // that legitimately produced no text is left alone.
    let mut any_tool_executed = false;

    for iteration in 0..MAX_ITERATIONS {
        if *cancel.borrow() {
            break;
        }

        let req = StreamRequest {
            messages: messages.clone(),
            model: model.clone(),
            tools: tools.clone(),
            chunk_tx: chunk_tx.clone(),
            cancel: cancel.clone(),
        };
        let result = provider.stream(req).await?;

        if let Some(usage) = &result.usage {
            total_input += usage.input_tokens;
            total_output += usage.output_tokens;
            if first_response_id.is_none() {
                first_response_id = usage.response_id.clone();
            }
        }
        // Accumulate — do NOT overwrite. The model often emits its answer text
        // in the same turn as a tool call and then a final empty tool-only/
        // closing turn; overwriting here would replace the answer with that
        // empty turn's content (the message saves blank even though the text
        // was streamed). Accumulating mirrors exactly what the client received
        // via chunk_tx, so the persisted content matches what was shown.
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
                if web_search_count > MAX_WEB_SEARCHES {
                    messages.push(ChatMessage::tool_result(
                        call.id.clone(),
                        format!(
                            "Web search budget exhausted ({} searches this turn). \
                             Do not search again — answer using the results you already have.",
                            MAX_WEB_SEARCHES
                        ),
                    ));
                    continue;
                }
            }

            sink.on_tool_use(call);
            let tool_result = registry.execute(call, &tool_ctx).await;
            sink.on_tool_result(&tool_result);
            messages.push(ChatMessage::tool_result(
                tool_result.tool_use_id.clone(),
                tool_result.content.clone(),
            ));
            any_tool_executed = true;
        }

        // Separator between tool-call rounds in streamed text — matches the
        // " " space the SPA emits in [src/services/tools/executor.ts:389].
        // Mirror it into final_content too so the saved text stays identical
        // to what was streamed.
        let _ = chunk_tx.send(" ".into());
        final_content.push(' ');

        tracing::debug!("tool loop iteration {} complete", iteration);
    }

    // Forced wrap-up. The model can use tools but never emit a text answer:
    // some providers (e.g. Gemini) emit tool calls with no narration and expect
    // to answer only at the end, and the turn can end blank either because the
    // final post-tool response carried empty content or because we hit
    // MAX_ITERATIONS while it still wanted tools. Either way the persisted
    // message would be empty and the conversation would appear to stall. Make
    // one more call *without* tools to force a written answer from the tool
    // results already accumulated in `messages`.
    if final_content.trim().is_empty() && any_tool_executed && !*cancel.borrow() {
        let req = StreamRequest {
            messages: messages.clone(),
            model: model.clone(),
            tools: vec![],
            chunk_tx: chunk_tx.clone(),
            cancel: cancel.clone(),
        };
        if let Ok(wrap) = provider.stream(req).await {
            if let Some(usage) = &wrap.usage {
                total_input += usage.input_tokens;
                total_output += usage.output_tokens;
                if first_response_id.is_none() {
                    first_response_id = usage.response_id.clone();
                }
            }
            final_content.push_str(&wrap.content);
            final_stop_reason = wrap.stop_reason;
        }
    }

    let usage = if total_input > 0 || total_output > 0 {
        Some(Usage {
            input_tokens: total_input,
            output_tokens: total_output,
            response_id: first_response_id,
            cost: None,
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
    use crate::vault::Vault;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Provider that replays a fixed script of `StreamResult`s, one per
    /// `stream()` call — lets us simulate a multi-turn agentic exchange.
    struct ScriptedProvider {
        steps: Mutex<VecDeque<StreamResult>>,
    }

    #[async_trait]
    impl Provider for ScriptedProvider {
        async fn stream(&self, _req: StreamRequest) -> anyhow::Result<StreamResult> {
            Ok(self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("stream() called more times than scripted"))
        }
        async fn generate_title(&self, _u: &str, _a: &str, _m: &str) -> String {
            String::new()
        }
    }

    fn usage(out: u32) -> Option<Usage> {
        Some(Usage { input_tokens: 1, output_tokens: out, response_id: None, cost: None })
    }

    /// A turn that emits `text` and then calls a tool. The tool is unregistered
    /// on purpose: `registry.execute` returns an error result with no network/IO,
    /// which is all this loop test needs (the model's behavior is scripted).
    fn tool_turn(text: &str, out: u32) -> StreamResult {
        StreamResult {
            content: text.into(),
            usage: usage(out),
            stop_reason: "tool_use".into(),
            tool_calls: vec![ToolCall { id: "t1".into(), name: "noop".into(), input: json!({}) }],
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

    async fn run(steps: Vec<StreamResult>) -> StreamResult {
        let (chunk_tx, _rx) = mpsc::unbounded_channel();
        let (_cancel_tx, cancel) = watch::channel(false);
        let req = LoopRequest {
            provider: Arc::new(ScriptedProvider { steps: Mutex::new(steps.into()) }),
            model: "test/model".into(),
            messages: vec![],
            tools: vec![],
            chunk_tx,
            cancel,
            tool_ctx: ToolContext {
                message_id: None,
                conversation_id: None,
                inside_subagent: false,
            },
        };
        execute_with_tools(req, test_registry(), Arc::new(NullSink))
            .await
            .unwrap()
    }

    /// Regression: the model emits its answer in the same turn as a tool call,
    /// then closes with an empty turn. The empty turn must NOT wipe the answer
    /// (the bug: `final_content` was overwritten each iteration, so the saved
    /// message came back blank despite the text having been streamed).
    #[tokio::test]
    async fn answer_in_a_tool_turn_survives_an_empty_closing_turn() {
        let result = run(vec![tool_turn("Here is the answer.", 1000), final_turn("", 20)]).await;
        assert_eq!(result.content, "Here is the answer.");
        // Usage accumulates across every model call in the turn.
        assert_eq!(result.usage.unwrap().output_tokens, 1020);
    }

    /// Text from multiple turns is concatenated — matching what gets streamed to
    /// the client — joined by the same " " round separator the loop emits.
    #[tokio::test]
    async fn text_accumulates_across_turns() {
        let result = run(vec![tool_turn("Searching.", 5), final_turn("Final answer.", 30)]).await;
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
        let mut steps: Vec<StreamResult> =
            (0..MAX_ITERATIONS).map(|_| tool_turn("", 10)).collect();
        steps.push(final_turn("Wrapped up.", 20));
        let result = run(steps).await;
        assert_eq!(result.content, "Wrapped up.");
    }

    /// Regression: a turn that produces text normally must NOT trigger an extra
    /// wrap-up call. The script holds exactly the expected number of turns;
    /// `ScriptedProvider` panics if `stream()` is called once more.
    #[tokio::test]
    async fn nonblank_turn_skips_wrap_up() {
        let result = run(vec![tool_turn("Looking.", 5), final_turn("Answer.", 10)]).await;
        assert_eq!(result.content, "Looking. Answer.");
    }
}
