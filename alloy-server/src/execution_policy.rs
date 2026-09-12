//! Internal limits for interactive and unattended model turns.
//!
//! A scheduled task values completeness over latency, while an interactive turn
//! must remain responsive. The policy is attached to `StartParams` with
//! `#[serde(skip)]`, so an HTTP caller cannot opt an ordinary chat into the more
//! expensive task limits. Task values may be overridden globally in
//! `config.yaml` and then per task; every value is clamped to a hard ceiling so
//! configuration can be generous without becoming unbounded.

use serde::{Deserialize, Serialize};

pub const INTERACTIVE_MAX_ITERATIONS: u32 = 10;
pub const INTERACTIVE_MAX_WEB_SEARCHES: u32 = 3;
pub const INTERACTIVE_MAX_SUBAGENTS: u32 = 3;
pub const INTERACTIVE_MAX_OUTPUT_TOKENS: u32 = 8_192;
/// Claude Code owns its agent loop, and historically interactive Alloy gave it
/// 20 turns. Keep that unchanged even though Alloy's own loop uses 10 rounds.
pub const INTERACTIVE_CLI_AGENT_TURNS: u32 = 20;

pub const TASK_MAX_ITERATIONS: u32 = 30;
pub const TASK_MAX_WEB_SEARCHES: u32 = 10;
pub const TASK_MAX_SUBAGENTS: u32 = 6;
pub const TASK_MAX_OUTPUT_TOKENS: u32 = 16_384;

const HARD_MAX_ITERATIONS: u32 = 100;
const HARD_MAX_WEB_SEARCHES: u32 = 50;
const HARD_MAX_SUBAGENTS: u32 = 12;
const HARD_MAX_OUTPUT_TOKENS: u32 = 32_768;
const MIN_OUTPUT_TOKENS: u32 = 1_024;

/// Optional values accepted both under top-level `taskExecution:` and an
/// individual task's `execution:` block. Per-task values take precedence.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_web_searches: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_subagents: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

impl ExecutionOverrides {
    pub fn is_empty(&self) -> bool {
        self.max_iterations.is_none()
            && self.max_web_searches.is_none()
            && self.max_subagents.is_none()
            && self.max_output_tokens.is_none()
    }
}

/// Fully resolved limits carried by one model turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionPolicy {
    pub max_iterations: u32,
    pub max_web_searches: u32,
    pub max_subagents: u32,
    pub max_output_tokens: u32,
    /// Provider-owned loops (currently Claude Code) need a separate resolved
    /// value so the interactive path can retain its historical 20-turn limit.
    pub cli_agent_turns: u32,
    pub is_task: bool,
}

impl Default for ExecutionPolicy {
    fn default() -> Self {
        Self::interactive()
    }
}

impl ExecutionPolicy {
    pub const fn interactive() -> Self {
        Self {
            max_iterations: INTERACTIVE_MAX_ITERATIONS,
            max_web_searches: INTERACTIVE_MAX_WEB_SEARCHES,
            max_subagents: INTERACTIVE_MAX_SUBAGENTS,
            max_output_tokens: INTERACTIVE_MAX_OUTPUT_TOKENS,
            cli_agent_turns: INTERACTIVE_CLI_AGENT_TURNS,
            is_task: false,
        }
    }

    /// Resolve task defaults, then global overrides, then per-task overrides.
    /// Values are clamped rather than trusted so no config can remove the
    /// runaway-loop/cost backstops. The effective values are logged by the task
    /// executor, making a clamped override diagnosable without logging content.
    pub fn task(global: &ExecutionOverrides, task: Option<&ExecutionOverrides>) -> Self {
        let task = task.copied().unwrap_or_default();
        let pick = |local: Option<u32>, shared: Option<u32>, default| {
            local.or(shared).unwrap_or(default)
        };
        let max_iterations = pick(
            task.max_iterations,
            global.max_iterations,
            TASK_MAX_ITERATIONS,
        )
        .clamp(1, HARD_MAX_ITERATIONS);
        let max_web_searches = pick(
            task.max_web_searches,
            global.max_web_searches,
            TASK_MAX_WEB_SEARCHES,
        )
        .clamp(1, HARD_MAX_WEB_SEARCHES);
        let max_subagents = pick(
            task.max_subagents,
            global.max_subagents,
            TASK_MAX_SUBAGENTS,
        )
        .clamp(1, HARD_MAX_SUBAGENTS);
        let max_output_tokens = pick(
            task.max_output_tokens,
            global.max_output_tokens,
            TASK_MAX_OUTPUT_TOKENS,
        )
        .clamp(MIN_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS);

        Self {
            max_iterations,
            max_web_searches,
            max_subagents,
            max_output_tokens,
            // `maxIterations` is the closest provider-neutral meaning for a CLI
            // that owns its loop. Interactive remains 20 via `interactive()`.
            cli_agent_turns: max_iterations,
            is_task: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_policy_keeps_the_existing_limits() {
        assert_eq!(
            ExecutionPolicy::interactive(),
            ExecutionPolicy {
                max_iterations: 10,
                max_web_searches: 3,
                max_subagents: 3,
                max_output_tokens: 8_192,
                cli_agent_turns: 20,
                is_task: false,
            }
        );
    }

    #[test]
    fn task_policy_is_generous_and_per_task_values_win() {
        let defaults = ExecutionPolicy::task(&ExecutionOverrides::default(), None);
        assert_eq!(defaults.max_iterations, 30);
        assert_eq!(defaults.max_web_searches, 10);
        assert_eq!(defaults.max_subagents, 6);
        assert_eq!(defaults.max_output_tokens, 16_384);
        assert!(defaults.is_task);

        let global = ExecutionOverrides {
            max_iterations: Some(40),
            max_web_searches: Some(12),
            max_subagents: Some(7),
            max_output_tokens: Some(20_000),
        };
        let local = ExecutionOverrides {
            max_iterations: Some(50),
            max_web_searches: None,
            max_subagents: Some(8),
            max_output_tokens: None,
        };
        let resolved = ExecutionPolicy::task(&global, Some(&local));
        assert_eq!(resolved.max_iterations, 50);
        assert_eq!(resolved.cli_agent_turns, 50);
        assert_eq!(resolved.max_web_searches, 12);
        assert_eq!(resolved.max_subagents, 8);
        assert_eq!(resolved.max_output_tokens, 20_000);
    }

    #[test]
    fn overrides_can_be_generous_but_never_unbounded_or_zero() {
        let extreme = ExecutionOverrides {
            max_iterations: Some(u32::MAX),
            max_web_searches: Some(0),
            max_subagents: Some(u32::MAX),
            max_output_tokens: Some(u32::MAX),
        };
        let resolved = ExecutionPolicy::task(&extreme, None);
        assert_eq!(resolved.max_iterations, HARD_MAX_ITERATIONS);
        assert_eq!(resolved.max_web_searches, 1);
        assert_eq!(resolved.max_subagents, HARD_MAX_SUBAGENTS);
        assert_eq!(resolved.max_output_tokens, HARD_MAX_OUTPUT_TOKENS);
    }
}
