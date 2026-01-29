import { useState, useEffect } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import './UpdateChecker.css';

// Export for use in Settings
export type CheckResult = { available: true; version: string } | { available: false } | { error: string };

export function UpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showNoUpdate, setShowNoUpdate] = useState(false);

  useEffect(() => {
    // Check for updates on mount (silent)
    checkForUpdates(false);

    // Expose for manual checks from Settings
    (window as any).checkForUpdates = () => checkForUpdates(true);
  }, []);

  const checkForUpdates = async (manual = false): Promise<CheckResult> => {
    console.log('[Updater] Checking for updates...', manual ? '(manual)' : '(auto)');
    setChecking(true);
    setError(null);
    setShowNoUpdate(false);
    setDismissed(false); // Reset dismissed state on manual check
    try {
      const available = await check();
      console.log('[Updater] Check result:', available);
      if (available) {
        console.log('[Updater] Update available:', available.version);
        setUpdate(available);
        return { available: true, version: available.version };
      } else {
        console.log('[Updater] No update available');
        if (manual) {
          setShowNoUpdate(true);
          // Auto-hide after 5 seconds
          setTimeout(() => setShowNoUpdate(false), 5000);
        }
        return { available: false };
      }
    } catch (err) {
      console.error('[Updater] Failed to check for updates:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (manual) {
        setError(`Failed to check for updates: ${errorMsg}`);
      }
      return { error: errorMsg };
    } finally {
      setChecking(false);
    }
  };

  const downloadAndInstall = async () => {
    if (!update) return;

    setDownloading(true);
    setProgress(0);
    setError(null);

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
      console.error('Failed to install update:', err);
      setError('Failed to install update. Please try again.');
      setDownloading(false);
    }
  };

  const dismiss = () => {
    setDismissed(true);
  };

  // Show checking state
  if (checking) {
    return (
      <div className="update-banner update-banner-checking">
        <div className="update-content">
          <div className="update-info">
            <span className="update-icon">⟳</span>
            <span className="update-text">Checking for updates...</span>
          </div>
        </div>
      </div>
    );
  }

  // Show "no updates" message after manual check
  if (showNoUpdate && !update) {
    return (
      <div className="update-banner update-banner-success">
        <div className="update-content">
          <div className="update-info">
            <span className="update-icon">✓</span>
            <span className="update-text">You're up to date!</span>
          </div>
          <button
            className="update-button update-button-secondary"
            onClick={() => setShowNoUpdate(false)}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // Show error if present
  if (error && !update) {
    return (
      <div className="update-banner update-banner-error">
        <div className="update-content">
          <div className="update-info">
            <span className="update-icon">!</span>
            <span className="update-text">{error}</span>
          </div>
          <button
            className="update-button update-button-secondary"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // Don't render if no update or dismissed
  if (!update || dismissed) {
    return null;
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
