//! Server-side cron scheduler for `vault/tasks/*.yaml`.

use std::{
    collections::HashSet,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use tokio::time::interval;

use crate::tasks::{
    executor,
    model::{self, ScheduledTask, TaskRunOutcome, TaskSchedule},
};
use crate::AppState;

const TICK_INTERVAL: Duration = Duration::from_secs(60);
const MAX_CATCHUP_OCCURRENCES: usize = 100_000;

#[derive(Clone, Default)]
pub struct InflightSet {
    inner: Arc<Mutex<HashSet<String>>>,
}

impl InflightSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn try_claim(&self, id: &str) -> bool {
        self.inner.lock().unwrap().insert(id.to_string())
    }

    pub fn release(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }
}

pub fn spawn(state: AppState, inflight: InflightSet) {
    tokio::spawn(async move {
        tracing::info!(
            "scheduled-task scheduler started ({}s tick)",
            TICK_INTERVAL.as_secs()
        );
        let mut tick = interval(TICK_INTERVAL);
        loop {
            tick.tick().await;
            if let Err(e) = run_tick(&state, &inflight).await {
                tracing::warn!("scheduled-task scheduler tick error: {}", e);
            }
        }
    });
}

async fn run_tick(state: &AppState, inflight: &InflightSet) -> anyhow::Result<()> {
    let tasks_dir = state.vault.resolve("tasks")?;
    let tasks = model::load_all(&tasks_dir).await?;
    let now = Utc::now();

    for (path, task) in tasks {
        if !task.enabled {
            continue;
        }
        let scheduled_for = match latest_due_occurrence(&task, now) {
            Ok(Some(value)) => value,
            Ok(None) => continue,
            Err(e) => {
                tracing::warn!("task {} has invalid schedule: {}", task.id, e);
                continue;
            }
        };
        if !inflight.try_claim(&task.id) {
            continue;
        }

        let state = state.clone();
        let inflight = inflight.clone();
        let tasks_dir = tasks_dir.clone();
        let id = task.id.clone();
        tokio::spawn(async move {
            let result = run_once(&state, &tasks_dir, &path, task, Some(scheduled_for)).await;
            if let Err(e) = result {
                tracing::warn!("task {} run failed: {}", id, e);
            }
            inflight.release(&id);
        });
    }
    Ok(())
}

/// Return the newest unhandled cron occurrence at or before `now`. Iterating
/// from the prior watermark means a new task (no watermark) waits for the first
/// occurrence after its creation, while an existing task catches up once.
pub(crate) fn latest_due_occurrence(
    task: &ScheduledTask,
    now: DateTime<Utc>,
) -> anyhow::Result<Option<DateTime<Utc>>> {
    let TaskSchedule { cron, timezone } = &task.schedule;
    let tz: Tz = timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("unknown timezone {}", timezone))?;
    let schedule = parse_cron(cron)?;
    let baseline = task
        .last_scheduled_at
        .as_deref()
        .and_then(parse_datetime)
        .or_else(|| parse_datetime(&task.created))
        .ok_or_else(|| anyhow::anyhow!("invalid created/lastScheduledAt timestamp"))?;
    let baseline_local = baseline.with_timezone(&tz);
    let now_local = now.with_timezone(&tz);
    let mut latest = None;
    let mut count = 0usize;
    for occurrence in schedule.after(&baseline_local) {
        if occurrence > now_local {
            break;
        }
        latest = Some(occurrence.with_timezone(&Utc));
        count += 1;
        if count >= MAX_CATCHUP_OCCURRENCES {
            // Avoid pathological startup work after very long downtime.
            // The current minute is a safe watermark: catch up once and
            // resume from the next future cron occurrence.
            return Ok(Some(now - ChronoDuration::seconds(now.timestamp() % 60)));
        }
    }
    Ok(latest)
}

pub fn parse_cron(expression: &str) -> anyhow::Result<Schedule> {
    if expression.split_whitespace().count() != 5 {
        anyhow::bail!("cron must contain exactly five fields");
    }
    // `cron` includes seconds as its first field; Alloy deliberately exposes
    // standard five-field cron and fixes seconds at zero.
    Schedule::from_str(&format!("0 {}", expression))
        .map_err(|e| anyhow::anyhow!("invalid cron expression: {}", e))
}

fn parse_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Run one task. `scheduled_for` is Some only for scheduler-initiated runs;
/// manual Run Now intentionally leaves `lastScheduledAt` untouched.
pub async fn run_once(
    state: &AppState,
    _tasks_dir: &std::path::Path,
    path: &std::path::Path,
    task: ScheduledTask,
    scheduled_for: Option<DateTime<Utc>>,
) -> anyhow::Result<TaskRunOutcome> {
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    model::update(path, |current| {
        apply_claim(current, &started_at, scheduled_for);
    })
    .await?;

    let outcome = executor::run(&task, state).await;
    model::update(path, |current| {
        executor::apply_outcome(current, &outcome);
    })
    .await?;

    // Fan out to email *after* the result is persisted. Best-effort: a send
    // failure is logged but never changes the task's own outcome.
    maybe_email_result(state, &task, &outcome, scheduled_for).await;

    Ok(outcome)
}

/// Email a delivered task result when the task opts in (`email: true`) and
/// `services.email` is configured. Only `completed`/`triggered` runs are
/// emailed; skips and errors are not.
async fn maybe_email_result(
    state: &AppState,
    task: &ScheduledTask,
    outcome: &TaskRunOutcome,
    scheduled_for: Option<DateTime<Utc>>,
) {
    use crate::tasks::model::TaskVerdict;

    if !task.email {
        return;
    }
    let Some(email_cfg) = state.config.email.as_ref() else {
        tracing::warn!(
            "task {} has email: true but services.email is not configured",
            task.id
        );
        return;
    };
    if !matches!(outcome.result, TaskVerdict::Completed | TaskVerdict::Triggered) {
        return;
    }
    if outcome.response.trim().is_empty() {
        return;
    }

    let delivered_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    // Deterministic per cron occurrence so a retry or a second Alloy racing the
    // same slot doesn't double-send; manual runs key off the delivery instant.
    let occurrence = scheduled_for
        .map(|s| s.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_else(|| delivered_at.clone());
    let idempotency_key = format!("task-{}-{}", task.id, occurrence);

    let email = crate::notify::TaskEmail {
        task_title: &task.title,
        model: &task.model,
        result_markdown: &outcome.response,
        delivered_at: &delivered_at,
        idempotency_key: &idempotency_key,
    };
    if let Err(e) = crate::notify::send_task_email(email_cfg, email).await {
        tracing::warn!("failed to email task {} result: {}", task.id, e);
    }
}

fn apply_claim(task: &mut ScheduledTask, started_at: &str, scheduled_for: Option<DateTime<Utc>>) {
    task.last_run_at = Some(started_at.to_string());
    if let Some(slot) = scheduled_for {
        task.last_scheduled_at = Some(slot.to_rfc3339_opts(SecondsFormat::Secs, true));
    }
}

pub async fn run_by_id(
    state: &AppState,
    inflight: &InflightSet,
    id: &str,
) -> anyhow::Result<TaskRunOutcome> {
    let tasks_dir = state.vault.resolve("tasks")?;
    let path = model::find_by_id(&tasks_dir, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("task not found: {}", id))?;
    let task = model::load_one(&path).await?;

    if !inflight.try_claim(id) {
        anyhow::bail!("task {} is already running", id);
    }
    let result = run_once(state, &tasks_dir, &path, task, None).await;
    inflight.release(id);
    result
}

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
    use crate::tasks::model::{TaskSchedule, TaskTrigger};
    use serde_yaml::Mapping;

    fn task(created: &str, last_scheduled: Option<&str>, cron: &str) -> ScheduledTask {
        ScheduledTask {
            id: "t".into(),
            created: created.into(),
            updated: created.into(),
            title: "t".into(),
            model: "x/y".into(),
            enabled: true,
            email: false,
            prompt: "p".into(),
            schedule: TaskSchedule {
                cron: cron.into(),
                timezone: "UTC".into(),
            },
            trigger: None::<TaskTrigger>,
            last_scheduled_at: last_scheduled.map(str::to_string),
            last_run_at: None,
            last_delivered_at: None,
            history: None,
            messages: vec![],
            extra: Mapping::new(),
        }
    }

    #[test]
    fn validates_five_field_cron() {
        assert!(parse_cron("0 8 * * 1").is_ok());
        assert!(parse_cron("0 0 8 * * 1").is_err());
        assert!(parse_cron("not cron here x y").is_err());
    }

    #[test]
    fn new_task_waits_for_first_future_slot() {
        let value = task("2026-07-20T08:01:00Z", None, "0 8 * * *");
        let now = DateTime::parse_from_rfc3339("2026-07-20T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(latest_due_occurrence(&value, now).unwrap(), None);
        let tomorrow = DateTime::parse_from_rfc3339("2026-07-21T08:00:10Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            latest_due_occurrence(&value, tomorrow).unwrap().unwrap(),
            DateTime::parse_from_rfc3339("2026-07-21T08:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn returns_latest_missed_slot_not_full_backlog() {
        let value = task(
            "2026-07-20T00:00:00Z",
            Some("2026-07-20T08:00:00Z"),
            "0 * * * *",
        );
        let now = DateTime::parse_from_rfc3339("2026-07-20T12:34:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            latest_due_occurrence(&value, now).unwrap().unwrap(),
            DateTime::parse_from_rfc3339("2026-07-20T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn handled_slot_does_not_repeat() {
        let value = task(
            "2026-07-20T00:00:00Z",
            Some("2026-07-20T12:00:00Z"),
            "0 * * * *",
        );
        let now = DateTime::parse_from_rfc3339("2026-07-20T12:34:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(latest_due_occurrence(&value, now).unwrap(), None);
    }

    #[test]
    fn timezone_controls_calendar_slot() {
        let mut value = task("2026-07-20T14:59:00Z", None, "0 8 * * *");
        value.schedule = TaskSchedule {
            cron: "0 8 * * *".into(),
            timezone: "America/Los_Angeles".into(),
        };
        let now = DateTime::parse_from_rfc3339("2026-07-20T15:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(latest_due_occurrence(&value, now).unwrap(), Some(now));
    }

    #[test]
    fn manual_claim_does_not_consume_cron_slot() {
        let mut value = task(
            "2026-07-20T00:00:00Z",
            Some("2026-07-20T08:00:00Z"),
            "0 8 * * *",
        );
        apply_claim(&mut value, "2026-07-20T09:00:00Z", None);
        assert_eq!(value.last_run_at.as_deref(), Some("2026-07-20T09:00:00Z"));
        assert_eq!(
            value.last_scheduled_at.as_deref(),
            Some("2026-07-20T08:00:00Z")
        );
    }

    #[test]
    fn scheduled_claim_records_the_cron_slot() {
        let mut value = task("2026-07-20T00:00:00Z", None, "0 8 * * *");
        let slot = DateTime::parse_from_rfc3339("2026-07-20T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        apply_claim(&mut value, "2026-07-20T08:07:00Z", Some(slot));
        assert_eq!(value.last_run_at.as_deref(), Some("2026-07-20T08:07:00Z"));
        assert_eq!(
            value.last_scheduled_at.as_deref(),
            Some("2026-07-20T08:00:00Z")
        );
    }

    #[test]
    fn inflight_claim_is_exclusive() {
        let set = InflightSet::new();
        assert!(set.try_claim("a"));
        assert!(!set.try_claim("a"));
        set.release("a");
        assert!(set.try_claim("a"));
    }
}
