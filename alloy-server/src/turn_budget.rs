//! Per-turn context budget.
//!
//! [`compaction`](crate::compaction) bounds what a *conversation* sends, but it
//! runs once, before the tool loop starts. Inside
//! [`execute_with_tools`](crate::tool_loop::execute_with_tools) every tool call
//! and every tool result is appended with no accounting at all, so one turn can
//! grow without limit. A real research turn reached 560,157 tokens against a
//! 262,144-token model and came back as an HTTP 400 after several minutes with
//! no answer.
//!
//! This module answers one question — "how much of the model's window would the
//! next request use?" — and leaves the policy to the loop:
//!
//! * **hard limit** — the most we will ever send. Past it we fail locally
//!   instead of handing the provider a prompt it must reject.
//! * **soft limit** — where the loop stops gathering evidence and writes its
//!   conclusion while there is still room to write one.
//!
//! The estimate is a heuristic (~4 chars/token), so it is *calibrated* against
//! the token counts the provider reports: after each call the ratio between the
//! real prompt size and our estimate of it corrects every later projection.
//! Calibration never scales below 1.0, so a provider that under-reports (or
//! reports nothing) cannot talk us into an optimistic budget.

use crate::providers::ChatMessage;
use crate::types::ToolDefinition;


/// Extra headroom for framing we can't measure: provider-side system additions,
/// role scaffolding, and tokenizer disagreement the calibration hasn't seen yet.
const SAFETY_FRACTION: f64 = 0.05;

/// Fraction of the usable input budget at which the loop stops asking for more
/// evidence. The remaining fifth is what the final answer is written from.
const SOFT_FRACTION: f64 = 0.8;

/// Never let a pathological reserve leave a uselessly small budget: whatever the
/// arithmetic says, a quarter of the window stays usable.
const MIN_USABLE_FRACTION: u64 = 4;

/// Calibration is a safety correction, not an optimization — it may only ever
/// scale our estimate *up*. The ceiling stops one anomalous usage report from
/// making every later projection absurd.
const MIN_CALIBRATION: f64 = 1.0;
const MAX_CALIBRATION: f64 = 8.0;

/// Rough per-message framing cost (role, delimiters). Matches the heuristic in
/// `compaction::estimate_one` and `ContextUsageChip.tsx`.
const PER_MESSAGE_OVERHEAD: u64 = 10;

/// Flat charge per image. Attachments are sent as base64, but providers bill
/// them as a fixed-ish block of tokens, so the encoded length is irrelevant.
const PER_IMAGE_TOKENS: u64 = 1_000;

/// The usable slice of a model's context window for one turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnBudget {
    /// The model's full advertised context window.
    pub window: u64,
    /// Most input tokens we will send. Past this the turn fails locally.
    pub hard_limit: u64,
    /// Where evidence gathering stops so a conclusion still fits.
    pub soft_limit: u64,
}

impl TurnBudget {
    pub fn new(window: u64) -> Self {
        Self::with_output_limit(
            window,
            crate::execution_policy::INTERACTIVE_MAX_OUTPUT_TOKENS,
        )
    }

    /// Reserve the actual reply allowance for this execution policy. Task runs
    /// can ask for a longer final report, so retaining the old fixed 8192-token
    /// reserve would let evidence crowd out the extra answer space.
    pub fn with_output_limit(window: u64, max_output_tokens: u32) -> Self {
        let reserve = u64::from(max_output_tokens).min(window / MIN_USABLE_FRACTION);
        let margin = (window as f64 * SAFETY_FRACTION) as u64;
        let hard_limit = window
            .saturating_sub(reserve + margin)
            .max(window / MIN_USABLE_FRACTION);
        Self {
            window,
            hard_limit,
            soft_limit: (hard_limit as f64 * SOFT_FRACTION) as u64,
        }
    }
}

/// Running token estimate for one turn, calibrated against reported usage.
///
/// With no known context window the ledger still estimates (so diagnostics stay
/// useful) but reports no limits, and the loop behaves exactly as it did before
/// budgeting existed — we refuse to invent a limit we don't know.
pub struct TokenLedger {
    budget: Option<TurnBudget>,
    tools_overhead: u64,
    calibration: f64,
}

impl TokenLedger {
    pub fn new(context_window: Option<u64>, tools: &[ToolDefinition]) -> Self {
        Self::with_output_limit(
            context_window,
            tools,
            crate::execution_policy::INTERACTIVE_MAX_OUTPUT_TOKENS,
        )
    }

    pub fn with_output_limit(
        context_window: Option<u64>,
        tools: &[ToolDefinition],
        max_output_tokens: u32,
    ) -> Self {
        Self {
            budget: context_window
                .filter(|w| *w > 0)
                .map(|window| TurnBudget::with_output_limit(window, max_output_tokens)),
            tools_overhead: estimate_tools(tools),
            calibration: MIN_CALIBRATION,
        }
    }

    pub fn budget(&self) -> Option<TurnBudget> {
        self.budget
    }

    /// Uncalibrated estimate of what a request carrying `messages` would cost,
    /// including the tool schemas sent alongside them.
    pub fn raw_estimate(&self, messages: &[ChatMessage]) -> u64 {
        self.tools_overhead + messages.iter().map(estimate_message).sum::<u64>()
    }

    /// Best estimate of the next request's prompt size, corrected by whatever
    /// the provider has reported so far this turn.
    pub fn projected(&self, messages: &[ChatMessage]) -> u64 {
        (self.raw_estimate(messages) as f64 * self.calibration) as u64
    }

    /// Fold a real prompt-token count into the correction factor. `estimated`
    /// must be the [`raw_estimate`](Self::raw_estimate) taken before that call.
    /// Providers that report nothing leave the ledger untouched.
    pub fn calibrate(&mut self, estimated: u64, actual_input_tokens: u32) {
        if actual_input_tokens == 0 || estimated == 0 {
            return;
        }
        let ratio = actual_input_tokens as f64 / estimated as f64;
        self.calibration = ratio.clamp(MIN_CALIBRATION, MAX_CALIBRATION);
    }

    pub fn over_soft_limit(&self, messages: &[ChatMessage]) -> bool {
        self.budget
            .is_some_and(|budget| self.projected(messages) > budget.soft_limit)
    }

    pub fn over_hard_limit(&self, messages: &[ChatMessage]) -> bool {
        self.budget
            .is_some_and(|budget| self.projected(messages) > budget.hard_limit)
    }
}

fn tokens_for(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

/// Tool schemas are re-sent with every request in the loop, so they are part of
/// the prompt whether or not the model uses them.
fn estimate_tools(tools: &[ToolDefinition]) -> u64 {
    tools
        .iter()
        .map(|tool| match serde_json::to_string(tool) {
            Ok(json) => tokens_for(&json),
            // An unserializable schema would never reach a provider either;
            // charge the description so the estimate stays non-zero.
            Err(_) => tokens_for(&tool.description),
        })
        .sum()
}

fn estimate_message(message: &ChatMessage) -> u64 {
    match message {
        ChatMessage::System { content } => tokens_for(content) + PER_MESSAGE_OVERHEAD,
        ChatMessage::User { content, images } => {
            tokens_for(content) + PER_MESSAGE_OVERHEAD + images.len() as u64 * PER_IMAGE_TOKENS
        }
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            tokens_for(content)
                + PER_MESSAGE_OVERHEAD
                + tool_calls
                    .iter()
                    .map(|call| {
                        tokens_for(&call.function.name)
                            + tokens_for(&call.function.arguments)
                            + PER_MESSAGE_OVERHEAD
                    })
                    .sum::<u64>()
        }
        ChatMessage::Tool { content, .. } => tokens_for(content) + PER_MESSAGE_OVERHEAD,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{AssistantToolCall, AssistantToolFunction, ImageData};

    fn user(content: &str) -> ChatMessage {
        ChatMessage::User {
            content: content.into(),
            images: Vec::new(),
        }
    }

    #[test]
    fn budget_reserves_room_for_an_answer_and_a_safety_margin() {
        // The window that produced the real 560k-token overflow.
        let budget = TurnBudget::new(262_144);
        assert_eq!(budget.hard_limit, 240_845);
        assert_eq!(budget.soft_limit, 192_676);
        assert!(budget.soft_limit < budget.hard_limit);
        assert!(budget.hard_limit < budget.window);

        let small = TurnBudget::new(131_072);
        assert!(small.hard_limit < 131_072);
        assert!(small.soft_limit < small.hard_limit);

        let task = TurnBudget::with_output_limit(262_144, 16_384);
        assert!(task.hard_limit < budget.hard_limit);
        assert!(task.soft_limit < budget.soft_limit);
    }

    #[test]
    fn tiny_windows_keep_a_usable_budget_instead_of_collapsing_to_zero() {
        // Reserving a flat 8192 output tokens from a 4095-token window would
        // leave nothing at all, failing every turn on small models.
        let budget = TurnBudget::new(4_095);
        assert!(budget.hard_limit >= 4_095 / 4);
        assert!(budget.soft_limit > 0);
    }

    #[test]
    fn an_unknown_window_disables_limits_without_disabling_estimates() {
        let ledger = TokenLedger::new(None, &[]);
        let huge = vec![user(&"x".repeat(10_000_000))];
        assert!(ledger.projected(&huge) > 0);
        assert!(!ledger.over_soft_limit(&huge));
        assert!(!ledger.over_hard_limit(&huge));
        assert!(ledger.budget().is_none());

        // A zero/absent advertised window is treated the same way.
        assert!(TokenLedger::new(Some(0), &[]).budget().is_none());
    }

    #[test]
    fn images_cost_a_flat_charge_rather_than_their_base64_length() {
        let with_image = ChatMessage::User {
            content: "look".into(),
            images: vec![ImageData {
                mime_type: "image/png".into(),
                base64: "A".repeat(4_000_000),
            }],
        };
        let ledger = TokenLedger::new(Some(200_000), &[]);
        // ~1k for the image, not ~1M for its encoding.
        assert!(ledger.projected(std::slice::from_ref(&with_image)) < 2_000);
    }

    #[test]
    fn tool_calls_and_results_are_counted_because_the_loop_resends_them() {
        let ledger = TokenLedger::new(Some(200_000), &[]);
        let assistant = ChatMessage::Assistant {
            content: String::new(),
            tool_calls: vec![AssistantToolCall {
                id: "t1".into(),
                typ: "function".into(),
                function: AssistantToolFunction {
                    name: "web_fetch".into(),
                    arguments: "x".repeat(400),
                },
            }],
        };
        let result = ChatMessage::Tool {
            tool_call_id: "t1".into(),
            content: "y".repeat(4_000),
        };
        assert!(ledger.projected(std::slice::from_ref(&assistant)) >= 100);
        assert!(ledger.projected(std::slice::from_ref(&result)) >= 1_000);
    }

    #[test]
    fn calibration_scales_projections_up_but_never_down() {
        let messages = vec![user(&"word ".repeat(4_000))];
        let mut ledger = TokenLedger::new(Some(200_000), &[]);
        let raw = ledger.raw_estimate(&messages);
        assert_eq!(ledger.projected(&messages), raw);

        // Provider reports the prompt cost twice our guess (dense markup, a
        // different tokenizer): every later projection must follow it up.
        ledger.calibrate(raw, (raw * 2) as u32);
        assert_eq!(ledger.projected(&messages), raw * 2);

        // A favorable report must not shrink the estimate below the heuristic.
        ledger.calibrate(raw, (raw / 4) as u32);
        assert_eq!(ledger.projected(&messages), raw);

        // Nothing reported (CLI adapters, cancelled turns) changes nothing.
        ledger.calibrate(raw, (raw * 3) as u32);
        ledger.calibrate(raw, 0);
        assert_eq!(ledger.projected(&messages), raw * 3);
    }

    #[test]
    fn calibration_is_capped_so_one_anomaly_cannot_wreck_the_budget() {
        let messages = vec![user("short")];
        let mut ledger = TokenLedger::new(Some(200_000), &[]);
        let raw = ledger.raw_estimate(&messages);
        ledger.calibrate(raw, u32::MAX);
        assert_eq!(ledger.projected(&messages), (raw as f64 * 8.0) as u64);
    }
}
