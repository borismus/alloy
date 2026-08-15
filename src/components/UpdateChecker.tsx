import { useState, useEffect } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getAutoUpdate } from '../services/autoUpdate';
import './UpdateChecker.css';

// Export for use in Settings
export type CheckResult = { available: true; version: string } | { available: false } | { error: string };

export function UpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);

  useEffect(() => {
    // Check for updates on mount (silent). When this machine opts into
    // automatic updates, install right here instead of waiting for someone to
    // click the banner — the whole point is an always-on box that nobody is
    // sitting in front of. Only ever on this startup check: auto-relaunching
    // mid-session would interrupt whatever is on screen.
    findUpdate(false)
      .catch((err) => {
        console.error('[Updater] Failed to check for updates:', err);
        return null;
      })
      .then((found) => {
        if (found && getAutoUpdate()) {
          console.info(`[Updater] auto-installing ${found.version}`);
          void downloadAndInstall(found);
        }
      });

    // Expose for manual checks from Settings, which wants the CheckResult shape.
    (window as any).checkForUpdates = () => checkForUpdates();
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
