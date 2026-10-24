//! Server-side cron scheduler for `vault/tasks/*.yaml`.

use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
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
    model::{self, ScheduledTask, TaskAttempt, TaskRun, TaskRunOutcome, TaskSchedule, TaskVerdict},
};
use crate::AppState;

const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// How often a running task refreshes `running.heartbeatAt` in its file.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2 * 60);
/// A `running` marker whose heartbeat is older than this belongs to a run
/// whose server died. Mirrored in `src/utils/taskRun.ts`.
pub const HEARTBEAT_STALE_AFTER: Duration = Duration::from_secs(5 * 60);
pub const INTERRUPTED_ERROR: &str = "Interrupted: Alloy stopped before the run finished.";
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

    /// Tasks executing right now, from cron or a manual **Run now**. Read by
    /// `/api/activity` so an unattended update can't restart mid-task.
    pub fn contains(&self, id: &str) -> bool {
        self.inner.lock().unwrap().contains(id)
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Claim `id` and run `work` on its own tokio task, releasing the claim
    /// when it ends, even by panic. Detached so a run outlives whoever started
    /// it: a manual **Run now** whose HTTP request drops (proxy timeout, phone
    /// asleep) still finishes, records its outcome, and frees the task. `None`
    /// when `id` is already running.
    pub fn spawn_claimed<F>(&self, id: &str, work: F) -> Option<tokio::task::JoinHandle<F::Output>>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        if !self.try_claim(id) {
            return None;
        }
        let claim = Claim(self.clone(), id.to_string());
        Some(tokio::spawn(async move {
            let _claim = claim;
            work.await
        }))
    }
}

/// Releases its task's inflight claim when dropped.
struct Claim(InflightSet, String);

impl Drop for Claim {
    fn drop(&mut self) {
        self.0.release(&self.1);
    }
}

pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            "scheduled-task scheduler started on {} ({}s tick)",
            state.runner_host,
            TICK_INTERVAL.as_secs()
        );
        let mut tick = interval(TICK_INTERVAL);
        loop {
            tick.tick().await;
            // On every host, not only the scheduled-task runner: Run now
            // works anywhere, so any host may have left a run behind.
            if let Err(e) = recover_interrupted(&state).await {
                tracing::warn!("interrupted-run recovery error: {}", e);
            }
            if let Err(e) = run_tick(&state).await {
                tracing::warn!("scheduled-task scheduler tick error: {}", e);
            }
        }
    })
}

async fn configured_runner(state: &AppState) -> anyhow::Result<Option<String>> {
    let path = state.vault.resolve("config.yaml")?;
    if !path.exists() {
        return Ok(None);
    }
    let text = tokio::fs::read_to_string(&path).await?;
    let raw = crate::config::parse_raw_config(&text)?;
    Ok(raw
        .scheduled_task_runner
        .map(|value| crate::host::normalize_hostname(&value))
        .filter(|value| !value.is_empty()))
}

async fn scheduler_is_active(state: &AppState) -> anyhow::Result<bool> {
    let assigned = configured_runner(state).await?;
    let current = state.runner_host.as_str();

    if let Some(assigned) = assigned.as_deref() {
        if !crate::host::is_current_host(assigned, current) {
            state.tasks.release_host_lock();
            if state.tasks.status_changed(format!("assigned:{assigned}")) {
                tracing::info!(
                    "scheduled tasks assigned to {}; scheduler inactive on {}",
                    assigned,
                    current
                );
            }
            return Ok(false);
        }
    }

    if !state.tasks.ensure_host_lock(state.vault.root())? {
        if state.tasks.status_changed("local-lock-held".into()) {
            tracing::warn!(
                "scheduled-task scheduler inactive: another Alloy process on {} owns this vault",
                current
            );
        }
        return Ok(false);
    }

    let legacy_assignment = assigned.is_none();
    let status = assigned
        .map(|host| format!("active:{host}"))
        .unwrap_or_else(|| "active:legacy".into());
    if state.tasks.status_changed(status) {
        if legacy_assignment {
            tracing::warn!(
                "scheduledTaskRunner is not configured; {} will run tasks using legacy multi-host behavior",
                current
            );
        } else {
            tracing::info!("scheduled-task scheduler active on {}", current);
        }
    }
    Ok(true)
}

async fn run_tick(state: &AppState) -> anyhow::Result<()> {
    if !scheduler_is_active(state).await? {
        return Ok(());
    }

    let inflight = &state.tasks.inflight;
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
        let state = state.clone();
        let tasks_dir = tasks_dir.clone();
        let id = task.id.clone();
        inflight.spawn_claimed(&id.clone(), async move {
            let result = run_once(&state, &tasks_dir, &path, task, Some(scheduled_for)).await;
            if let Err(e) = result {
                tracing::warn!("task {} run failed: {}", id, e);
            }
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
        apply_claim(current, &started_at, scheduled_for, state.runner_host.as_str());
    })
    .await?;

    let outcome = with_heartbeat(
        path,
        &started_at,
        HEARTBEAT_INTERVAL,
        executor::run(&task, state),
    )
    .await;
    model::update(path, |current| {
        executor::apply_outcome(current, &outcome, state.runner_host.as_str());
    })
    .await?;

    // Fan out to email *after* the result is persisted. Best-effort: a send
    // failure is logged but never changes the task's own outcome.
    maybe_email_result(state, &task, &outcome, scheduled_for).await;

    Ok(outcome)
}

/// Email a task result or first failure when the task opts in (`email: true`)
/// and `services.email` is configured. Deliberate skips remain silent. An
/// ongoing error streak sends only its first alert so an offline host cannot
/// produce one email per cron occurrence.
async fn maybe_email_result(
    state: &AppState,
    task: &ScheduledTask,
    outcome: &TaskRunOutcome,
    scheduled_for: Option<DateTime<Utc>>,
) {
    use crate::notify::TaskEmailKind;

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
    let Some(kind) = email_kind(task, outcome) else {
        return;
    };
    let content = match kind {
        TaskEmailKind::Result => outcome.response.trim().to_string(),
        TaskEmailKind::Error => {
            let detail = outcome
                .error
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Unknown task execution error");
            let bounded_error = detail.chars().take(2_000).collect::<String>();
            let raw_response = outcome.response.trim();
            if raw_response.is_empty() {
                format!("Error:\n{}", bounded_error)
            } else {
                let bounded_response = raw_response.chars().take(4_000).collect::<String>();
                format!(
                    "Error:\n{}\n\nModel response:\n{}",
                    bounded_error, bounded_response
                )
            }
        }
    };

    let occurred_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    // Deterministic per cron occurrence so a retry or a second Alloy racing the
    // same slot doesn't double-send; manual runs key off the delivery instant.
    let occurrence = scheduled_for
        .map(|s| s.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_else(|| occurred_at.clone());
    let kind_key = match kind {
        TaskEmailKind::Result => "result",
        TaskEmailKind::Error => "error",
    };
    let idempotency_key = format!("task-{}-{}-{}", kind_key, task.id, occurrence);

    let email = crate::notify::TaskEmail {
        kind,
        task_id: &task.id,
        task_title: &task.title,
        model: &task.model,
        runner: state.runner_host.as_str(),
        content_markdown: &content,
        occurred_at: &occurred_at,
        idempotency_key: &idempotency_key,
    };
    if let Err(e) = crate::notify::send_task_email(email_cfg, email).await {
        tracing::warn!("failed to email task {} notification: {}", task.id, e);
    }
}

fn email_kind(
    task: &ScheduledTask,
    outcome: &TaskRunOutcome,
) -> Option<crate::notify::TaskEmailKind> {
    use crate::notify::TaskEmailKind;
    use crate::tasks::model::TaskVerdict;

    match outcome.result {
        TaskVerdict::Completed | TaskVerdict::Triggered if !outcome.response.trim().is_empty() => {
            Some(TaskEmailKind::Result)
        }
        TaskVerdict::Error => {
            let previous_was_error = task
                .history
                .as_ref()
                .and_then(|history| history.first())
                .is_some_and(|attempt| attempt.result == TaskVerdict::Error);
            (!previous_was_error).then_some(TaskEmailKind::Error)
        }
        TaskVerdict::Completed | TaskVerdict::Triggered | TaskVerdict::Skipped => None,
    }
}

fn apply_claim(
    task: &mut ScheduledTask,
    started_at: &str,
    scheduled_for: Option<DateTime<Utc>>,
    host: &str,
) {
    task.last_run_at = Some(started_at.to_string());
    task.running = Some(TaskRun {
        host: host.to_string(),
        started_at: started_at.to_string(),
        heartbeat_at: started_at.to_string(),
    });
    if let Some(slot) = scheduled_for {
        task.last_scheduled_at = Some(slot.to_rfc3339_opts(SecondsFormat::Secs, true));
    }
}

/// Run `work` while refreshing the task's `running.heartbeatAt` every
/// `every`. The heartbeat is fully stopped before this returns, so the
/// caller's final write can't be overwritten by a late heartbeat; if `work`
/// panics, the guard aborts it and the marker goes stale instead.
async fn with_heartbeat<F: std::future::Future>(
    path: &Path,
    started_at: &str,
    every: Duration,
    work: F,
) -> F::Output {
    struct AbortOnDrop(tokio::task::JoinHandle<()>);
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    let beat_path = path.to_path_buf();
    let beat_started_at = started_at.to_string();
    let mut beat = AbortOnDrop(tokio::spawn(async move {
        let mut tick = interval(every);
        tick.tick().await; // the first tick is immediate; the claim just wrote one
        loop {
            tick.tick().await;
            let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            let result = model::update(&beat_path, |task| {
                // Only this run's marker: never resurrect a cleared one.
                if let Some(run) = task.running.as_mut().filter(|run| run.started_at == beat_started_at) {
                    run.heartbeat_at = now;
                }
            })
            .await;
            if let Err(e) = result {
                tracing::warn!("task heartbeat {} failed: {}", beat_path.display(), e);
            }
        }
    }));

    let output = work.await;
    beat.0.abort();
    let _ = (&mut beat.0).await;
    output
}

/// Record runs this host left behind (crash, quit, restart mid-run) as
/// interrupted. Only this host's markers, only stale ones, and never one this
/// process is still running: another Alloy on the same Mac (say, a dev
/// server on the same vault) keeps its own live run's heartbeat fresh.
async fn recover_interrupted(state: &AppState) -> anyhow::Result<()> {
    let tasks_dir = state.vault.resolve("tasks")?;
    recover_interrupted_in(&tasks_dir, state.runner_host.as_str(), &state.tasks.inflight, Utc::now()).await
}

async fn recover_interrupted_in(
    tasks_dir: &Path,
    host: &str,
    inflight: &InflightSet,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let is_abandoned = |task: &ScheduledTask| {
        task.running.as_ref().is_some_and(|run| {
            crate::host::is_current_host(&run.host, host)
                && !inflight.contains(&task.id)
                && heartbeat_is_stale(&run.heartbeat_at, now)
        })
    };
    for (path, task) in model::load_all(tasks_dir).await? {
        if !is_abandoned(&task) {
            continue;
        }
        tracing::warn!("task {} run was interrupted; recording it", task.id);
        let now_iso = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        model::update(&path, |current| {
            // Re-check against the fresh read: the run may have finished.
            if !is_abandoned(current) {
                return;
            }
            current.running = None;
            current.last_run_at = Some(now_iso.clone());
            model::push_history(
                current,
                TaskAttempt {
                    timestamp: now_iso.clone(),
                    result: TaskVerdict::Error,
                    reasoning: String::new(),
                    runner: Some(host.to_string()),
                    error: Some(INTERRUPTED_ERROR.to_string()),
                    usage: None,
                },
            );
        })
        .await?;
    }
    Ok(())
}

fn heartbeat_is_stale(heartbeat_at: &str, now: DateTime<Utc>) -> bool {
    match DateTime::parse_from_rfc3339(heartbeat_at) {
        Ok(at) => now.signed_duration_since(at.with_timezone(&Utc))
            > ChronoDuration::from_std(HEARTBEAT_STALE_AFTER).unwrap(),
        // Unparseable means nobody can be keeping it fresh.
        Err(_) => true,
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

    let state = state.clone();
    let run = inflight
        .spawn_claimed(id, async move { run_once(&state, &tasks_dir, &path, task, None).await })
        .ok_or_else(|| anyhow::anyhow!("task {} is already running", id))?;
    run.await?
}

#[derive(Clone)]
pub struct SchedulerHandle {
    pub inflight: InflightSet,
    host_lock: Arc<Mutex<Option<File>>>,
    last_status: Arc<Mutex<Option<String>>>,
}

impl SchedulerHandle {
    pub fn new() -> Self {
        Self {
            inflight: InflightSet::new(),
            host_lock: Arc::new(Mutex::new(None)),
            last_status: Arc::new(Mutex::new(None)),
        }
    }

    fn lock_path(vault_root: &Path) -> PathBuf {
        let identity = vault_root
            .canonicalize()
            .unwrap_or_else(|_| vault_root.to_path_buf());
        // Stable FNV-1a rather than DefaultHasher: production and development
        // binaries built with different Rust versions must derive the same lock.
        let mut hash = 0xcbf29ce484222325u64;
        for byte in identity.to_string_lossy().as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        std::env::temp_dir().join(format!("alloy-scheduler-{hash:016x}.lock"))
    }

    /// Hold an OS-local, per-vault advisory lock for the lifetime of this
    /// scheduler. The shared runner hostname prevents cross-machine races; this
    /// lock prevents a production and development Alloy on the same host from
    /// both matching that hostname.
    fn ensure_host_lock(&self, vault_root: &Path) -> anyhow::Result<bool> {
        let mut slot = self.host_lock.lock().unwrap();
        if slot.is_some() {
            return Ok(true);
        }
        let path = Self::lock_path(vault_root);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)?;
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                *slot = Some(file);
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    fn release_host_lock(&self) {
        self.host_lock.lock().unwrap().take();
    }

    pub fn host_lock_held(&self) -> bool {
        self.host_lock.lock().unwrap().is_some()
    }

    fn status_changed(&self, next: String) -> bool {
        let mut current = self.last_status.lock().unwrap();
        if current.as_deref() == Some(next.as_str()) {
            false
        } else {
            *current = Some(next);
            true
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
    use crate::notify::TaskEmailKind;
    use crate::tasks::model::{TaskAttempt, TaskSchedule, TaskTrigger, TaskVerdict};
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
            execution: None,
            last_scheduled_at: last_scheduled.map(str::to_string),
            last_run_at: None,
            last_delivered_at: None,
            history: None,
            running: None,
            messages: vec![],
            extra: Mapping::new(),
        }
    }

    #[tokio::test]
    async fn claimed_run_finishes_and_releases_after_caller_drops() {
        let inflight = InflightSet::new();
        let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

        // The caller awaits the run like the Run now handler does; aborting it
        // stands in for axum dropping the handler when the request goes away.
        let caller = tokio::spawn({
            let inflight = inflight.clone();
            async move {
                let run = inflight
                    .spawn_claimed("t", async move {
                        start_rx.await.unwrap();
                        done_tx.send(()).unwrap();
                    })
                    .unwrap();
                run.await.unwrap();
            }
        });
        tokio::task::yield_now().await;
        assert!(inflight.spawn_claimed("t", async {}).is_none());
        caller.abort();
        let _ = caller.await;

        start_tx.send(()).unwrap();
        done_rx.await.expect("run should finish after its caller is gone");
        tokio::task::yield_now().await;
        assert!(inflight.is_empty());
        assert!(inflight.spawn_claimed("t", async {}).is_some());
    }

    #[tokio::test]
    async fn claimed_run_releases_when_it_panics() {
        let inflight = InflightSet::new();
        let run = inflight.spawn_claimed("t", async { panic!("boom") }).unwrap();
        assert!(run.await.is_err());
        assert!(inflight.is_empty());
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
        apply_claim(&mut value, "2026-07-20T09:00:00Z", None, "smusmini");
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
        apply_claim(&mut value, "2026-07-20T08:07:00Z", Some(slot), "smusmini");
        assert_eq!(value.last_run_at.as_deref(), Some("2026-07-20T08:07:00Z"));
        assert_eq!(
            value.last_scheduled_at.as_deref(),
            Some("2026-07-20T08:00:00Z")
        );
    }

    #[test]
    fn claim_marks_the_task_running_until_its_outcome_lands() {
        let mut value = task("2026-07-20T00:00:00Z", None, "0 8 * * *");
        apply_claim(&mut value, "2026-07-20T09:00:00Z", None, "smusmini");
        assert_eq!(
            value.running,
            Some(TaskRun {
                host: "smusmini".into(),
                started_at: "2026-07-20T09:00:00Z".into(),
                heartbeat_at: "2026-07-20T09:00:00Z".into(),
            })
        );

        let failed = TaskRunOutcome {
            result: TaskVerdict::Error,
            response: String::new(),
            error: Some("boom".into()),
            usage: None,
        };
        executor::apply_outcome(&mut value, &failed, "smusmini");
        assert_eq!(value.running, None);
    }

    fn running_task(id: &str, host: &str, heartbeat_at: &str) -> ScheduledTask {
        let mut value = task("2026-07-20T00:00:00Z", None, "0 8 * * *");
        value.id = id.into();
        value.running = Some(TaskRun {
            host: host.into(),
            started_at: "2026-07-20T09:00:00.000Z".into(),
            heartbeat_at: heartbeat_at.into(),
        });
        value
    }

    #[tokio::test]
    async fn heartbeat_refreshes_while_running_and_never_writes_after() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.yaml");
        let started = "2026-07-20T09:00:00.000Z";
        model::write_atomic(&path, &running_task("t", "smusmini", started)).await.unwrap();

        let every = Duration::from_millis(20);
        with_heartbeat(&path, started, every, tokio::time::sleep(every * 5)).await;
        let beat = model::load_one(&path).await.unwrap().running.unwrap().heartbeat_at;
        assert_ne!(beat, started, "heartbeat should have advanced");

        // The caller's final write clears the marker; nothing may restore it.
        model::update(&path, |t| t.running = None).await.unwrap();
        tokio::time::sleep(every * 4).await;
        assert_eq!(model::load_one(&path).await.unwrap().running, None);
    }

    #[tokio::test]
    async fn heartbeat_stops_when_the_run_panics() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.yaml");
        let started = "2026-07-20T09:00:00.000Z";
        model::write_atomic(&path, &running_task("t", "smusmini", started)).await.unwrap();

        let every = Duration::from_millis(20);
        let run_path = path.clone();
        let run = tokio::spawn(async move {
            with_heartbeat(&run_path, started, every, async move {
                tokio::time::sleep(every * 3).await;
                panic!("boom");
            })
            .await
        });
        assert!(run.await.is_err());

        let after_panic = model::load_one(&path).await.unwrap().running.unwrap().heartbeat_at;
        tokio::time::sleep(every * 4).await;
        let later = model::load_one(&path).await.unwrap().running.unwrap().heartbeat_at;
        assert_eq!(after_panic, later, "heartbeat must stop with the run");
    }

    #[tokio::test]
    async fn recovery_records_only_this_hosts_abandoned_runs() {
        let dir = tempfile::tempdir().unwrap();
        let now = DateTime::parse_from_rfc3339("2026-07-20T10:00:00Z").unwrap().with_timezone(&Utc);
        let stale = "2026-07-20T09:50:00.000Z";
        let fresh = "2026-07-20T09:58:00.000Z";
        for value in [
            running_task("abandoned", "smusmini", stale),
            running_task("live", "smusmini", fresh),
            running_task("other-host", "legomenon", stale),
            running_task("in-process", "smusmini", stale),
        ] {
            model::write_atomic(&dir.path().join(format!("{}.yaml", value.id)), &value).await.unwrap();
        }
        let inflight = InflightSet::new();
        assert!(inflight.try_claim("in-process"));

        recover_interrupted_in(dir.path(), "smusmini", &inflight, now).await.unwrap();

        let path_of = |id: &str| dir.path().join(format!("{id}.yaml"));
        let abandoned = model::load_one(&path_of("abandoned")).await.unwrap();
        assert_eq!(abandoned.running, None);
        let attempt = &abandoned.history.unwrap()[0];
        assert_eq!(attempt.result, TaskVerdict::Error);
        assert_eq!(attempt.error.as_deref(), Some(INTERRUPTED_ERROR));
        assert_eq!(attempt.runner.as_deref(), Some("smusmini"));

        for id in ["live", "other-host", "in-process"] {
            let value = model::load_one(&path_of(id)).await.unwrap();
            assert!(value.running.is_some(), "{id} must keep its marker");
            assert!(value.history.is_none(), "{id} must not gain history");
        }
    }

    #[test]
    fn email_semantics_distinguish_delivery_skip_and_first_failure() {
        let mut value = task("2026-07-20T00:00:00Z", None, "0 8 * * *");
        let outcome = |result, response: &str, error: Option<&str>| TaskRunOutcome {
            result,
            response: response.into(),
            error: error.map(str::to_string),
            usage: None,
        };

        assert_eq!(
            email_kind(&value, &outcome(TaskVerdict::Completed, "report", None)),
            Some(TaskEmailKind::Result)
        );
        assert_eq!(
            email_kind(&value, &outcome(TaskVerdict::Triggered, "alert", None)),
            Some(TaskEmailKind::Result)
        );
        assert_eq!(
            email_kind(&value, &outcome(TaskVerdict::Skipped, "not changed", None)),
            None
        );
        assert_eq!(
            email_kind(
                &value,
                &outcome(TaskVerdict::Error, "", Some("model unavailable"))
            ),
            Some(TaskEmailKind::Error)
        );

        value.history = Some(vec![TaskAttempt {
            timestamp: "2026-07-20T01:00:00Z".into(),
            result: TaskVerdict::Error,
            reasoning: String::new(),
            runner: Some("legomenon".into()),
            error: Some("still unavailable".into()),
            usage: None,
        }]);
        assert_eq!(
            email_kind(
                &value,
                &outcome(TaskVerdict::Error, "", Some("model unavailable"))
            ),
            None,
            "continuing error streak must not spam"
        );

        value.history.as_mut().unwrap()[0].result = TaskVerdict::Skipped;
        assert_eq!(
            email_kind(
                &value,
                &outcome(TaskVerdict::Error, "", Some("model unavailable"))
            ),
            Some(TaskEmailKind::Error),
            "an error after a non-error run starts a new alertable streak"
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

    /// `/api/activity` reports this, so a running task must be visible and a
    /// released one must not linger.
    #[test]
    fn inflight_reports_how_many_tasks_are_running() {
        let set = InflightSet::new();
        assert!(set.is_empty());
        assert!(set.try_claim("a"));
        assert!(set.try_claim("b"));
        assert_eq!(set.len(), 2);
        assert!(!set.is_empty());
        set.release("a");
        set.release("b");
        assert_eq!(set.len(), 0);
        assert!(set.is_empty());
    }

    #[test]
    fn host_lock_allows_only_one_local_scheduler_per_vault() {
        let vault = tempfile::tempdir().unwrap();
        let first = SchedulerHandle::new();
        let second = SchedulerHandle::new();

        assert!(first.ensure_host_lock(vault.path()).unwrap());
        assert!(!second.ensure_host_lock(vault.path()).unwrap());
        first.release_host_lock();
        assert!(second.ensure_host_lock(vault.path()).unwrap());
    }
}
