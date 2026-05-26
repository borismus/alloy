//! Background scheduler: every 60 s, scan `vault/triggers/*.yaml`, fire
//! any that are due, write the outcome back to YAML.
//!
//! Replaces the browser-side `window.setInterval` loop in
//! [src/services/triggers/scheduler.ts](src/services/triggers/scheduler.ts).
//! With this in place, triggers fire whether or not any client is connected.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use tokio::time::interval;

use crate::triggers::{
    executor,
    logs::{self, TriggerLogEntry},
    model::{self, Trigger, TriggerVerdict},
};
use crate::AppState;

const TICK_INTERVAL: Duration = Duration::from_secs(60);

/// Tracks triggers currently being executed so concurrent ticks don't
/// double-fire the same trigger (e.g. if a manual `/run` is in flight when
/// the scheduler tick comes around).
#[derive(Clone, Default)]
pub struct InflightSet {
    inner: Arc<Mutex<HashSet<String>>>,
}

impl InflightSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Try to claim a trigger. Returns true if claimed, false if already
    /// running.
    pub fn try_claim(&self, id: &str) -> bool {
        self.inner.lock().unwrap().insert(id.to_string())
    }

    pub fn release(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }
}

/// Spawn the background scheduler. Runs forever; aborts when the
/// `AppState` (and therefore the embedded server) is dropped via the
/// task being cancelled.
pub fn spawn(state: AppState, inflight: InflightSet) {
    tokio::spawn(async move {
        tracing::info!("trigger scheduler started ({}s tick)", TICK_INTERVAL.as_secs());
        let mut tick = interval(TICK_INTERVAL);
        // tokio's interval fires immediately on the first tick — matches
        // the TS scheduler's "run immediately to catch up" behavior.
        loop {
            tick.tick().await;
            if let Err(e) = run_tick(&state, &inflight).await {
                tracing::warn!("trigger scheduler tick error: {}", e);
            }
        }
    });
}

async fn run_tick(state: &AppState, inflight: &InflightSet) -> anyhow::Result<()> {
    let triggers_dir = state.vault.resolve("triggers")?;
    let triggers = model::load_all(&triggers_dir).await?;
    let now = Utc::now();

    for (path, trigger) in triggers {
        if !trigger.enabled {
            continue;
        }
        if !is_due(&trigger, now) {
            continue;
        }
        if !inflight.try_claim(&trigger.id) {
            continue;
        }

        // Spawn each run so a slow trigger doesn't block the others.
        let state = state.clone();
        let inflight = inflight.clone();
        let triggers_dir = triggers_dir.clone();
        let id = trigger.id.clone();
        tokio::spawn(async move {
            let res = run_once(&state, &triggers_dir, &path, trigger).await;
            if let Err(e) = res {
                tracing::warn!("trigger {} run failed: {}", id, e);
            }
            inflight.release(&id);
        });
    }
    Ok(())
}

fn is_due(trigger: &Trigger, now: DateTime<Utc>) -> bool {
    let Some(last) = trigger.last_checked.as_deref() else {
        return true;
    };
    let Ok(last_dt) = DateTime::parse_from_rfc3339(last) else {
        return true;
    };
    let elapsed = now - last_dt.with_timezone(&Utc);
    elapsed.num_minutes() >= trigger.interval_minutes as i64
}

/// Run a single trigger: claim by writing lastChecked, execute, write the
/// outcome back. Used by both the scheduler tick and the `/run` HTTP route.
pub async fn run_once(
    state: &AppState,
    triggers_dir: &std::path::Path,
    path: &std::path::Path,
    trigger: Trigger,
) -> anyhow::Result<crate::triggers::model::TriggerRunOutcome> {
    let id = trigger.id.clone();
    let title = trigger.title.clone();

    // Claim by writing lastChecked first (matches TS behavior — surfaces
    // the trigger as "running" in any UI watching the file).
    let claim_now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    model::update(path, |t| {
        t.last_checked = Some(claim_now.clone());
    })
    .await?;

    let outcome = executor::run(&trigger, state).await;

    // Write the result back.
    model::update(path, |t| {
        executor::apply_outcome(t, &outcome);
    })
    .await?;

    // Append to logs.yaml (mirrors the TS triggerLogService.appendLog call).
    let log_entry = TriggerLogEntry {
        timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        conversation_id: id,
        conversation_title: Some(title),
        triggered: outcome.result == TriggerVerdict::Triggered,
        reasoning: match outcome.result {
            TriggerVerdict::Triggered | TriggerVerdict::Skipped => {
                outcome.response.chars().take(200).collect()
            }
            TriggerVerdict::Error => String::new(),
        },
        error: outcome.error.clone(),
    };
    let _ = logs::append(triggers_dir, log_entry).await;

    Ok(outcome)
}

/// Public entry point for the `/api/triggers/{id}/run` route. Resolves the
/// trigger's YAML path, claims via `InflightSet`, and runs to completion.
pub async fn run_by_id(
    state: &AppState,
    inflight: &InflightSet,
    id: &str,
) -> anyhow::Result<crate::triggers::model::TriggerRunOutcome> {
    let triggers_dir = state.vault.resolve("triggers")?;
    let path = model::find_by_id(&triggers_dir, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("trigger not found: {}", id))?;
    let trigger = model::load_one(&path).await?;

    if !inflight.try_claim(id) {
        anyhow::bail!("trigger {} is already running", id);
    }
    let result = run_once(state, &triggers_dir, &path, trigger).await;
    inflight.release(id);
    result
}

/// Convenience wrapper used by `lib.rs` setup to expose the inflight set
/// to both the scheduler and the route handler.
#[derive(Clone)]
pub struct SchedulerHandle {
    pub inflight: InflightSet,
}

impl SchedulerHandle {
    pub fn new() -> Self {
        Self {
            inflight: InflightSet::new(),
        }
    }
}

impl Default for SchedulerHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;

    fn mk_trigger(last_checked: Option<&str>, interval: u32) -> Trigger {
        Trigger {
            id: "t".into(),
            created: "now".into(),
            updated: "now".into(),
            title: "t".into(),
            model: "x/y".into(),
            enabled: true,
            trigger_prompt: "p".into(),
            interval_minutes: interval,
            last_checked: last_checked.map(String::from),
            last_triggered: None,
            history: None,
            messages: vec![],
            extra: Default::default(),
        }
    }

    #[test]
    fn due_when_never_checked() {
        let t = mk_trigger(None, 60);
        assert!(is_due(&t, Utc::now()));
    }

    #[test]
    fn due_when_interval_elapsed() {
        let now = Utc::now();
        let an_hour_ago = (now - ChronoDuration::minutes(61))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let t = mk_trigger(Some(&an_hour_ago), 60);
        assert!(is_due(&t, now));
    }

    #[test]
    fn not_due_when_recent() {
        let now = Utc::now();
        let recent = (now - ChronoDuration::minutes(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let t = mk_trigger(Some(&recent), 60);
        assert!(!is_due(&t, now));
    }

    #[test]
    fn inflight_claim_is_exclusive() {
        let s = InflightSet::new();
        assert!(s.try_claim("a"));
        assert!(!s.try_claim("a"));
        s.release("a");
        assert!(s.try_claim("a"));
    }
}
