import { useState, useEffect } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
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
    // Check for updates on mount (silent)
    checkForUpdates(false);

    // Expose for manual checks from Settings
    (window as any).checkForUpdates = () => checkForUpdates(true);
  }, []);

  const checkForUpdates = async (manual = false): Promise<CheckResult> => {
    console.log('[Updater] Checking for updates...', manual ? '(manual)' : '(auto)');
    if (manual) {
      setDismissed(false); // Reset dismissed state on manual check
    }
    try {
      const available = await check();
      console.log('[Updater] Check result:', available);
      if (available) {
        console.log('[Updater] Update available:', available.version);
        setUpdate(available);
        return { available: true, version: available.version };
      } else {
        console.log('[Updater] No update available');
        return { available: false };
      }
    } catch (err) {
      console.error('[Updater] Failed to check for updates:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return { error: errorMsg };
    }
  };

  const downloadAndInstall = async () => {
    if (!update) return;

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
                onClick={downloadAndInstall}
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
