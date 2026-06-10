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
        final_content = result.content.clone();
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
            sink.on_tool_use(call);

            // Enforce the per-turn web_search budget. Once spent, return an
            // error result instead of executing so the model stops searching
            // and synthesizes from the results it already has.
            let tool_result = if call.name == "web_search" && {
                web_search_count += 1;
                web_search_count > MAX_WEB_SEARCHES
            } {
                ToolResult {
                    tool_use_id: call.id.clone(),
                    content: format!(
                        "Web search budget exhausted ({} searches this turn). \
                         Do not search again — answer using the results you already have.",
                        MAX_WEB_SEARCHES
                    ),
                    is_error: Some(true),
                }
            } else {
                registry.execute(call, &tool_ctx).await
            };
            sink.on_tool_result(&tool_result);
            messages.push(ChatMessage::tool_result(
                tool_result.tool_use_id.clone(),
                tool_result.content.clone(),
            ));
        }

        // Separator between tool-call rounds in streamed text — matches the
        // " " space the SPA emits in [src/services/tools/executor.ts:389].
        let _ = chunk_tx.send(" ".into());

        tracing::debug!("tool loop iteration {} complete", iteration);
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
        content: final_content,
        usage,
        stop_reason: final_stop_reason,
        tool_calls: Vec::new(),
    })
}
