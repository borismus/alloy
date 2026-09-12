//! When an unattended machine may install an update, and how long to wait next.
//!
//! The decision lives here, away from the Tauri shell that performs it, so it
//! is covered by the ordinary test gate. The shell supplies facts — is the
//! preference on, is the server idle, is an update available — and executes
//! whatever this returns.
//!
//! Previously this loop ran in the webview. That was wrong twice over: macOS
//! throttles timers in a window that is never in front, which is exactly the
//! always-on machine this feature exists for; and its decisions were written to
//! the webview console, unreachable over SSH, so "it hasn't updated" could not
//! be diagnosed at all. In the shell it uses a real timer and the same rotating
//! log as everything else.

use std::time::Duration;

/// Settle time before the first attempt after launch.
pub const FIRST_CHECK: Duration = Duration::from_secs(10);
/// Between ordinary checks. One request for a small static manifest, so an
/// hour keeps an unattended machine close to current without hammering the
/// release host.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// After the preference is switched on, so enabling it visibly does something.
pub const PREFERENCE_CHECK: Duration = Duration::from_secs(2);
/// After deferring to running work: short enough to catch a quiet window, long
/// enough not to re-ask throughout a long task.
pub const BUSY_RETRY: Duration = Duration::from_secs(10 * 60);
/// After a failure, so a broken download can't retry as often as a clean check.
pub const ERROR_RETRY: Duration = Duration::from_secs(3 * 60 * 60);

/// What one attempt concluded. Logged verbatim, so each value has to be worth
/// reading in a log six hours later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// This machine has not opted in.
    Disabled,
    /// No vault bound yet, so there is no server whose work we could protect.
    NotReady,
    /// Already current.
    UpToDate,
    /// An update exists but work is in flight; nothing was downloaded.
    BusyBeforeInstall,
    /// Staged on disk, but work started before the restart could happen.
    BusyAfterInstall,
    /// Installed; the process is restarting.
    Installed,
    /// The check or the download failed.
    Failed,
}

impl UpdateOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NotReady => "not_ready",
            Self::UpToDate => "up_to_date",
            Self::BusyBeforeInstall => "busy_before_install",
            Self::BusyAfterInstall => "busy_after_install",
            Self::Installed => "installed",
            Self::Failed => "failed",
        }
    }

    /// How long to wait before trying again.
    pub fn retry_after(self) -> Duration {
        match self {
            Self::BusyBeforeInstall | Self::BusyAfterInstall => BUSY_RETRY,
            Self::Failed => ERROR_RETRY,
            _ => CHECK_INTERVAL,
        }
    }
}

/// The step the shell should take now. Split from [`UpdateOutcome`] so the
/// decision is testable without a Tauri runtime or a real release server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStep {
    /// Do nothing this cycle; the outcome explains why.
    Stop(UpdateOutcome),
    /// Ask the update server whether a newer version exists.
    CheckForUpdate,
    /// Download and install the update already known to exist.
    Install,
    /// Restart into an update staged by an earlier cycle.
    Restart,
}

/// Facts the shell gathers before each step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateConditions {
    /// The per-machine preference, re-read every cycle so toggling it applies
    /// without a restart.
    pub enabled: bool,
    /// `None` when no vault is bound yet and there is no server state to ask.
    pub idle: Option<bool>,
    /// An update was installed earlier but the restart had to be deferred.
    pub staged: bool,
}

/// Decide what to do before contacting the update server.
///
/// Idle is deliberately consulted *before* downloading, so a busy machine does
/// no work at all, and the caller checks it again before restarting — a turn or
/// scheduled task can begin while bytes are arriving. Unknown idleness is
/// treated as busy: the cost of waiting is a late update, the cost of guessing
/// wrong is killing a running task.
pub fn plan(conditions: UpdateConditions) -> UpdateStep {
    if !conditions.enabled {
        return UpdateStep::Stop(UpdateOutcome::Disabled);
    }
    match conditions.idle {
        None => UpdateStep::Stop(UpdateOutcome::NotReady),
        Some(false) if conditions.staged => UpdateStep::Stop(UpdateOutcome::BusyAfterInstall),
        Some(false) => UpdateStep::Stop(UpdateOutcome::BusyBeforeInstall),
        // Bytes are already on disk; only the restart is outstanding, so don't
        // download them again.
        Some(true) if conditions.staged => UpdateStep::Restart,
        Some(true) => UpdateStep::CheckForUpdate,
    }
}

/// Decide what to do once the update server has answered.
pub fn plan_after_check(update_available: bool) -> UpdateStep {
    if update_available {
        UpdateStep::Install
    } else {
        UpdateStep::Stop(UpdateOutcome::UpToDate)
    }
}

/// Decide whether the freshly installed update may be applied now. Called with
/// idleness re-sampled after the download.
pub fn plan_after_install(idle_now: Option<bool>) -> UpdateStep {
    match idle_now {
        Some(true) => UpdateStep::Restart,
        _ => UpdateStep::Stop(UpdateOutcome::BusyAfterInstall),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conditions(enabled: bool, idle: Option<bool>, staged: bool) -> UpdateConditions {
        UpdateConditions {
            enabled,
            idle,
            staged,
        }
    }

    #[test]
    fn an_opted_out_machine_never_contacts_the_update_server() {
        assert_eq!(
            plan(conditions(false, Some(true), false)),
            UpdateStep::Stop(UpdateOutcome::Disabled)
        );
        // Even with an update already staged, opting out stops the restart.
        assert_eq!(
            plan(conditions(false, Some(true), true)),
            UpdateStep::Stop(UpdateOutcome::Disabled)
        );
    }

    #[test]
    fn an_idle_opted_in_machine_checks_then_installs() {
        assert_eq!(
            plan(conditions(true, Some(true), false)),
            UpdateStep::CheckForUpdate
        );
        assert_eq!(plan_after_check(true), UpdateStep::Install);
        assert_eq!(
            plan_after_check(false),
            UpdateStep::Stop(UpdateOutcome::UpToDate)
        );
    }

    #[test]
    fn work_in_flight_defers_without_downloading_anything() {
        assert_eq!(
            plan(conditions(true, Some(false), false)),
            UpdateStep::Stop(UpdateOutcome::BusyBeforeInstall)
        );
    }

    /// The race the second idle check exists for: idle when the download began,
    /// busy by the time it finished.
    #[test]
    fn a_turn_that_starts_during_the_download_prevents_the_restart() {
        assert_eq!(
            plan_after_install(Some(false)),
            UpdateStep::Stop(UpdateOutcome::BusyAfterInstall)
        );
        assert_eq!(plan_after_install(Some(true)), UpdateStep::Restart);
    }

    #[test]
    fn a_staged_update_restarts_later_without_downloading_again() {
        assert_eq!(plan(conditions(true, Some(true), true)), UpdateStep::Restart);
        assert_eq!(
            plan(conditions(true, Some(false), true)),
            UpdateStep::Stop(UpdateOutcome::BusyAfterInstall)
        );
    }

    /// Not knowing must never be read as "safe to restart".
    #[test]
    fn unknown_idleness_is_treated_as_busy() {
        assert_eq!(
            plan(conditions(true, None, false)),
            UpdateStep::Stop(UpdateOutcome::NotReady)
        );
        assert_eq!(
            plan_after_install(None),
            UpdateStep::Stop(UpdateOutcome::BusyAfterInstall)
        );
    }

    #[test]
    fn deferrals_retry_sooner_than_failures() {
        assert_eq!(UpdateOutcome::BusyBeforeInstall.retry_after(), BUSY_RETRY);
        assert_eq!(UpdateOutcome::BusyAfterInstall.retry_after(), BUSY_RETRY);
        assert_eq!(UpdateOutcome::Failed.retry_after(), ERROR_RETRY);
        assert_eq!(UpdateOutcome::UpToDate.retry_after(), CHECK_INTERVAL);
        assert!(BUSY_RETRY < CHECK_INTERVAL);
        assert!(CHECK_INTERVAL < ERROR_RETRY);
    }
}
