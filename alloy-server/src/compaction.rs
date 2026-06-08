//! Conversation compaction — a cost-saving transform on what we send to the
//! model, never on what we store.
//!
//! The full message history always lives in `conversations/{id}.yaml` and is
//! shown in the UI. Compaction only changes the bytes handed to the provider:
//! older turns are folded into a single `compacted` summary message, and at
//! send time we transmit the *most recent* compacted message (rendered as a
//! plain user turn) plus everything after it — dropping everything before it.
//!
//! Compacted messages are first-class, persisted, and **cumulative**: each new
//! one folds in the previous summary plus the turns that have aged out since.
//! Older compacted messages stay in the array as history; only the last one is
//! ever sent.
//!
//! Trigger is an **absolute token budget** (`compaction.triggerTokens`, default
//! 16000), not a fraction of the context window — context windows can be huge
//! (1M+) and this is primarily about not resending an ever-growing history every
//! turn. The retain budget (how much recent history stays verbatim) is half the
//! trigger. Both are clamped to `0.6·cw` for small-window models so we never
//! overflow.

use crate::providers::{ChatMessage, Provider, WireMessage, wire_to_chat};
use crate::vault::Vault;

/// Default trigger budget when config doesn't override it.
pub const DEFAULT_TRIGGER_TOKENS: u64 = 16_000;
/// Max tokens for the summary completion (~500 words ≈ ~700 tokens).
const SUMMARY_MAX_TOKENS: u32 = 800;

const SUMMARY_SYSTEM: &str = "You are compacting a long conversation to save context. \
Produce a faithful, well-structured summary in UNDER 500 words that preserves: key decisions made, \
important facts and definitions established, open questions and unresolved threads, named entities \
(people, files, systems, identifiers), and any commitments or next steps. Use concise prose or bullet \
points. Do NOT add commentary, preamble, or a title — output only the summary. If an existing summary \
is provided, merge the newer messages into it while keeping the result within the length budget.";

/// Runtime settings (sourced from `config.yaml`).
#[derive(Debug, Clone, Copy)]
pub struct CompactionSettings {
    pub enabled: bool,
    pub trigger_tokens: u64,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            trigger_tokens: DEFAULT_TRIGGER_TOKENS,
        }
    }
}

/// A summary the caller should persist into the vault.
#[derive(Debug, Clone)]
pub struct NewCompacted {
    /// Id of the first retained message; the compacted message is inserted
    /// immediately before it in the vault array. `None` if that message had no
    /// id, in which case the caller should skip persistence (the next turn
    /// retries).
    pub anchor_id: Option<String>,
    pub content: String,
}

/// Result of preparing a turn for sending.
pub struct Prepared {
    /// The messages to actually send to the provider (system prompt prepended).
    pub send: Vec<ChatMessage>,
    /// A new compacted summary to persist, if one was generated this turn.
    pub new_compacted: Option<NewCompacted>,
}

struct Budget {
    trigger: u64,
    retain: u64,
}

/// Rough token estimate for one wire message: ~4 chars/token + per-message
/// overhead + a flat charge per image. `log` messages cost nothing (they're
/// never sent). Mirrors the client-side heuristic in ContextUsageChip.tsx.
fn estimate_one(m: &WireMessage) -> u64 {
    if m.role == "log" {
        return 0;
    }
    let chars = m.content.chars().count() as u64;
    chars.div_ceil(4) + 10 + m.attachments.len() as u64 * 1000
}

fn estimate_tokens(msgs: &[WireMessage]) -> u64 {
    msgs.iter().map(estimate_one).sum()
}

/// Index of the last `compacted` message (the start of the "send view"), or 0.
fn send_view_start(msgs: &[WireMessage]) -> usize {
    msgs.iter()
        .rposition(|m| m.role == "compacted")
        .unwrap_or(0)
}

fn effective_budget(trigger_tokens: u64, cw: Option<u64>) -> Budget {
    let trigger = match cw {
        Some(c) => trigger_tokens.min((c as f64 * 0.6) as u64),
        None => trigger_tokens,
    }
    .max(1);
    Budget {
        trigger,
        retain: trigger / 2,
    }
}

fn needs_compaction(view: &[WireMessage], cw: Option<u64>, trigger_tokens: u64) -> bool {
    estimate_tokens(view) >= effective_budget(trigger_tokens, cw).trigger
}

/// Pick the split point within `view`: messages `[0, retain_from)` get
/// summarized, `[retain_from, len)` stay verbatim. Walks from the end keeping
/// recent messages until the retain budget is exceeded. Always retains at least
/// the final message; returns `None` if there'd be nothing to summarize.
fn pick_cutoff(view: &[WireMessage], cw: Option<u64>, trigger_tokens: u64) -> Option<usize> {
    if view.len() < 2 {
        return None;
    }
    let retain = effective_budget(trigger_tokens, cw).retain;
    let mut acc = 0u64;
    let mut retain_from = view.len();
    for i in (0..view.len()).rev() {
        let t = estimate_one(&view[i]);
        // Always keep the last message (first iteration); afterwards stop once
        // adding another would exceed the retain budget.
        if retain_from < view.len() && acc + t > retain {
            break;
        }
        acc += t;
        retain_from = i;
    }
    if retain_from == 0 {
        return None; // everything fit in the retain budget — nothing to summarize
    }
    Some(retain_from)
}

/// Render messages as a plain-text transcript for the summarizer. Images are
/// noted but not embedded.
fn render_excerpt(msgs: &[WireMessage]) -> String {
    msgs.iter()
        .filter(|m| m.role != "log")
        .map(|m| {
            let role = match m.role.as_str() {
                "user" => "User",
                "assistant" => "Assistant",
                "compacted" => "Summary",
                other => other,
            };
            let mut s = format!("{}: {}", role, m.content);
            if !m.attachments.is_empty() {
                s.push_str(&format!(" [{} image(s) omitted]", m.attachments.len()));
            }
            s
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn summary_wire(summary: &str) -> WireMessage {
    WireMessage {
        id: None,
        role: "user".into(),
        content: format!("Summary of earlier conversation:\n\n{}", summary),
        attachments: Vec::new(),
    }
}

fn assistant_ack() -> WireMessage {
    WireMessage {
        id: None,
        role: "assistant".into(),
        content: "Understood — continuing from the summary above.".into(),
        attachments: Vec::new(),
    }
}

/// Push the summary (as a user turn) followed by the retained tail. Inserts a
/// short assistant acknowledgment between them when the tail starts with a user
/// turn, so providers that require strict user/assistant alternation (Anthropic
/// via OpenRouter) don't see two user turns back to back.
fn push_summary_and_tail(effective: &mut Vec<WireMessage>, summary: &str, tail: &[WireMessage]) {
    effective.push(summary_wire(summary));
    if tail.first().map(|m| m.role != "assistant").unwrap_or(false) {
        effective.push(assistant_ack());
    }
    effective.extend_from_slice(tail);
}

/// Prepare a turn: compute the send view, render any existing compacted message
/// as context, and — if enabled and over budget — generate a new cumulative
/// summary to fold in older turns. Returns the messages to send plus an optional
/// summary to persist.
///
/// On summary-generation failure we fall back to sending the un-compacted send
/// view (the provider error, if any, surfaces normally) and persist nothing.
pub async fn prepare(
    messages: &[WireMessage],
    system_prompt: Option<&str>,
    vault: Option<&Vault>,
    provider: &dyn Provider,
    model: &str,
    cw: Option<u64>,
    settings: &CompactionSettings,
) -> Prepared {
    let start = send_view_start(messages);
    let view = &messages[start..];
    let head_is_compacted = view.first().map(|m| m.role == "compacted").unwrap_or(false);

    let mut new_compacted = None;
    let mut effective: Vec<WireMessage> = Vec::new();

    if settings.enabled && needs_compaction(view, cw, settings.trigger_tokens) {
        if let Some(retain_from) = pick_cutoff(view, cw, settings.trigger_tokens) {
            let summarize_start = if head_is_compacted { 1 } else { 0 };
            let to_summarize = &view[summarize_start..retain_from];
            if !to_summarize.is_empty() {
                let prior = if head_is_compacted {
                    Some(view[0].content.as_str())
                } else {
                    None
                };
                let excerpt = render_excerpt(to_summarize);
                let user = match prior {
                    Some(p) => format!(
                        "Existing summary of the conversation so far:\n\n{}\n\n---\n\nNewer messages to fold into the summary:\n\n{}",
                        p, excerpt
                    ),
                    None => format!("Conversation to summarize:\n\n{}", excerpt),
                };
                if let Some(summary) = provider
                    .complete_once(SUMMARY_SYSTEM, &user, model, SUMMARY_MAX_TOKENS)
                    .await
                {
                    let anchor_id = view.get(retain_from).and_then(|m| m.id.clone());
                    push_summary_and_tail(&mut effective, &summary, &view[retain_from..]);
                    new_compacted = Some(NewCompacted {
                        anchor_id,
                        content: summary,
                    });
                } else {
                    tracing::warn!("compaction: summary generation failed; sending uncompacted");
                }
            }
        }
    }

    if effective.is_empty() {
        // No new summary this turn. Still render an existing compacted head as a
        // context turn and drop everything before it.
        if head_is_compacted {
            push_summary_and_tail(&mut effective, &view[0].content, &view[1..]);
        } else {
            effective.extend_from_slice(view);
        }
    }

    let send = wire_to_chat(&effective, system_prompt, vault).await;
    Prepared {
        send,
        new_compacted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{StreamRequest, StreamResult};
    use async_trait::async_trait;

    fn wire(role: &str, content: &str) -> WireMessage {
        WireMessage {
            id: Some(format!("id-{}-{}", role, content.len())),
            role: role.into(),
            content: content.into(),
            attachments: Vec::new(),
        }
    }

    fn user_of_size(id: &str, chars: usize) -> WireMessage {
        WireMessage {
            id: Some(id.into()),
            role: "user".into(),
            content: "x".repeat(chars),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn estimate_skips_logs_and_counts_images() {
        assert_eq!(estimate_one(&wire("log", "anything at all")), 0);
        // 8 chars -> ceil(8/4)=2, +10 overhead = 12
        assert_eq!(estimate_one(&wire("user", "abcdefgh")), 12);
        let mut m = wire("user", "");
        m.attachments
            .push(crate::providers::WireAttachment { path: "a".into(), mime_type: "image/png".into() });
        assert_eq!(estimate_one(&m), 10 + 1000);
    }

    #[test]
    fn send_view_start_finds_last_compacted() {
        let msgs = vec![
            wire("user", "a"),
            wire("compacted", "s1"),
            wire("user", "b"),
            wire("compacted", "s2"),
            wire("user", "c"),
        ];
        assert_eq!(send_view_start(&msgs), 3);
        assert_eq!(send_view_start(&[wire("user", "a"), wire("assistant", "b")]), 0);
    }

    #[test]
    fn effective_budget_clamps_and_halves() {
        // No window: use trigger directly.
        let b = effective_budget(16_000, None);
        assert_eq!(b.trigger, 16_000);
        assert_eq!(b.retain, 8_000);
        // Huge window: absolute cap dominates.
        let b = effective_budget(16_000, Some(1_000_000));
        assert_eq!(b.trigger, 16_000);
        // Small window: 0.6*cw dominates.
        let b = effective_budget(16_000, Some(10_000));
        assert_eq!(b.trigger, 6_000);
        assert_eq!(b.retain, 3_000);
    }

    #[test]
    fn pick_cutoff_retains_tail_under_budget() {
        // retain budget with trigger 1000, no cw -> 500. Each msg ~ (400/4)+10 = 110 tokens.
        let view: Vec<WireMessage> = (0..10).map(|i| user_of_size(&format!("m{i}"), 400)).collect();
        let cut = pick_cutoff(&view, None, 1000).unwrap();
        // Retained suffix must be < ~500 tokens; 4 msgs = 440, 5 = 550 (>500).
        let retained: u64 = view[cut..].iter().map(estimate_one).sum();
        assert!(retained <= 500, "retained {} should be <= 500", retained);
        assert!(cut >= 1, "must summarize at least one message");
    }

    #[test]
    fn pick_cutoff_none_when_short_or_small() {
        assert_eq!(pick_cutoff(&[wire("user", "a")], None, 1000), None);
        // Two tiny messages well under the retain budget -> nothing to summarize.
        assert_eq!(
            pick_cutoff(&[wire("user", "hi"), wire("user", "yo")], None, 16_000),
            None
        );
    }

    // Stub provider whose summary call returns a fixed string and records calls.
    struct StubProvider {
        summary: Option<String>,
    }

    #[async_trait]
    impl Provider for StubProvider {
        async fn stream(&self, _req: StreamRequest) -> anyhow::Result<StreamResult> {
            unimplemented!()
        }
        async fn generate_title(&self, _u: &str, _a: &str, _m: &str) -> String {
            String::new()
        }
        async fn complete_once(
            &self,
            _system: &str,
            _user: &str,
            _model: &str,
            _max_tokens: u32,
        ) -> Option<String> {
            self.summary.clone()
        }
    }

    #[tokio::test]
    async fn prepare_compacts_and_renders_summary_first() {
        // 12 large user messages, trigger small enough to force compaction.
        let msgs: Vec<WireMessage> = (0..12)
            .map(|i| user_of_size(&format!("m{i}"), 400))
            .collect();
        let provider = StubProvider {
            summary: Some("SUMMARY TEXT".into()),
        };
        let prepared = prepare(
            &msgs,
            None,
            None,
            &provider,
            "test/model",
            None,
            &CompactionSettings { enabled: true, trigger_tokens: 1000 },
        )
        .await;

        // First sent message is the rendered summary user turn.
        match &prepared.send[0] {
            ChatMessage::User { content, .. } => {
                assert!(content.starts_with("Summary of earlier conversation:"));
                assert!(content.contains("SUMMARY TEXT"));
            }
            other => panic!("expected first message to be a user summary, got {other:?}"),
        }
        // Fewer messages sent than the full history (older ones dropped).
        assert!(prepared.send.len() < msgs.len());
        // A summary to persist, anchored at the first retained message.
        let nc = prepared.new_compacted.expect("should produce a compacted message");
        assert_eq!(nc.content, "SUMMARY TEXT");
        assert!(nc.anchor_id.is_some());
    }

    #[tokio::test]
    async fn prepare_noop_when_under_budget() {
        let msgs = vec![wire("user", "hello"), wire("assistant", "hi")];
        let provider = StubProvider { summary: None };
        let prepared = prepare(
            &msgs,
            None,
            None,
            &provider,
            "test/model",
            None,
            &CompactionSettings::default(),
        )
        .await;
        assert!(prepared.new_compacted.is_none());
        assert_eq!(prepared.send.len(), 2);
    }

    #[tokio::test]
    async fn prepare_disabled_still_renders_existing_compacted() {
        // An existing compacted message should be rendered as context and
        // everything before it dropped, even when generation is disabled.
        let msgs = vec![
            wire("user", "old one"),
            wire("user", "old two"),
            wire("compacted", "PRIOR SUMMARY"),
            wire("user", "recent"),
        ];
        let provider = StubProvider { summary: None };
        let prepared = prepare(
            &msgs,
            None,
            None,
            &provider,
            "test/model",
            None,
            &CompactionSettings { enabled: false, trigger_tokens: 16_000 },
        )
        .await;
        assert!(prepared.new_compacted.is_none());
        // Sent: [summary(user), assistant-ack, recent(user)] — the two "old"
        // messages are dropped; the ack keeps user/assistant alternation since
        // the retained tail starts with a user turn.
        assert_eq!(prepared.send.len(), 3);
        match &prepared.send[0] {
            ChatMessage::User { content, .. } => {
                assert!(content.contains("PRIOR SUMMARY"));
            }
            other => panic!("expected summary user turn, got {other:?}"),
        }
        assert!(matches!(prepared.send[1], ChatMessage::Assistant { .. }));
    }
}
