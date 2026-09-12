import { useState, useEffect, useRef } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getAutoUpdate, isServerIdle, runAutoUpdateCycle } from '../services/autoUpdate';
import { isTauri } from '../services/api';
import './UpdateChecker.css';

/** Let the app settle before the first unattended attempt. */
const FIRST_CHECK_MS = 10_000;
/** Between ordinary checks. An always-on machine has no launch to piggyback on,
 *  but the release cadence doesn't justify polling harder than this. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After deferring for a busy server. Short enough to catch a quiet window,
 *  long enough not to re-ask constantly during a long task. */
const BUSY_RETRY_MS = 10 * 60 * 1000;
/** After a failure, so a broken download can't become a retry loop. */
const ERROR_RETRY_MS = 60 * 60 * 1000;

// Export for use in Settings
export type CheckResult = { available: true; version: string } | { available: false } | { error: string };

export function UpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  /** An update already written to disk, still waiting for an idle moment to
   *  restart into. Survives cycles so the bytes are fetched only once. */
  const pendingInstall = useRef(false);

  useEffect(() => {
    // Silent check on mount so the banner is available to everyone, including
    // machines that have not opted into unattended updates.
    findUpdate(false).catch((err) => {
      console.error('[Updater] Failed to check for updates:', err);
      return null;
    });

    // Expose for manual checks from Settings, which wants the CheckResult shape.
    (window as any).checkForUpdates = () => checkForUpdates();
  }, []);

  // Unattended updates for an opted-in always-on machine. Browser clients are
  // excluded: they can't install anything, and "restart" there would just be a
  // page reload of someone else's session.
  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const outcome = await runAutoUpdateCycle<Update>({
        // Re-read each cycle so toggling the setting takes effect without a
        // restart, and so a machine that opts out stops immediately.
        enabled: getAutoUpdate,
        findUpdate: () => check().then((u) => u ?? null),
        isIdle: isServerIdle,
        install: async (update) => {
          await update.downloadAndInstall();
          pendingInstall.current = true;
        },
        relaunch,
        pendingInstall: pendingInstall.current,
      });
      if (cancelled) return;

      if (outcome !== 'disabled' && outcome !== 'none') {
        console.info(`[Updater] unattended update: ${outcome}`);
      }
      const delay =
        outcome === 'busy-before-install' || outcome === 'busy-after-install' ? BUSY_RETRY_MS
          : outcome === 'error' ? ERROR_RETRY_MS
          : CHECK_INTERVAL_MS;
      // A self-scheduling timeout rather than an interval: a slow download must
      // never overlap with the next attempt.
      timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, FIRST_CHECK_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Returns the Update itself so the auto-install path can act on it
  // immediately, without waiting a render for the `update` state to land.
  const findUpdate = async (manual: boolean): Promise<Update | null> => {
    if (manual) {
      setDismissed(false); // Reset dismissed state on manual check
    }
    const available = await check();
    if (available) setUpdate(available);
    return available ?? null;
  };

  /** Settings-facing wrapper: never throws, reports outcome as a CheckResult. */
  const checkForUpdates = async (): Promise<CheckResult> => {
    try {
      const available = await findUpdate(true);
      return available ? { available: true, version: available.version } : { available: false };
    } catch (err) {
      console.error('[Updater] Failed to check for updates:', err);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const downloadAndInstall = async (target: Update | null = update) => {
    if (!target) return;
    const update = target;

    setDownloading(true);
    setProgress(0);

    try {
      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              setProgress(Math.round((downloaded / contentLength) * 100));
            }
            break;
          case 'Finished':
            setProgress(100);
            break;
        }
      });

      // Relaunch the app to apply the update
      await relaunch();
    } catch (err) {
      console.error('[Updater] Failed to install update:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      setInstallError(errorMsg);
      setDownloading(false);
    }
  };

  const dismiss = () => {
    setDismissed(true);
  };

  // Don't render if no update or dismissed
  if (!update || dismissed) {
    return null;
  }

  // Show install error with details
  if (installError) {
    return (
      <div className="update-banner update-banner-error">
        <div className="update-content">
          <div className="update-info">
            <span className="update-icon">!</span>
            <span className="update-text">
              Update to {update.version} failed
              <button
                className="update-details-toggle"
                onClick={() => setShowErrorDetails(!showErrorDetails)}
                title={showErrorDetails ? "Hide details" : "Show details"}
              >
                {showErrorDetails ? '▼' : '▶'}
              </button>
            </span>
          </div>
          <div className="update-actions">
            <button
              className="update-button update-button-primary"
              onClick={() => {
                setInstallError(null);
                downloadAndInstall();
              }}
            >
              Retry
            </button>
            <button
              className="update-button update-button-secondary"
              onClick={dismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
        {showErrorDetails && (
          <div className="update-error-details">
            {installError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="update-banner">
      <div className="update-content">
        <div className="update-info">
          <span className="update-icon">↑</span>
          <span className="update-text">
            Version {update.version} is available
          </span>
        </div>
        <div className="update-actions">
          {downloading ? (
            <div className="update-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="progress-text">{progress}%</span>
            </div>
          ) : (
            <>
              <button
                className="update-button update-button-primary"
                onClick={() => downloadAndInstall()}
              >
                Update Now
              </button>
              <button
                className="update-button update-button-secondary"
                onClick={dismiss}
              >
                Later
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
