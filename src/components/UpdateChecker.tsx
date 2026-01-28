import { useState, useEffect } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import './UpdateChecker.css';

export function UpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check for updates on mount
    checkForUpdates();
  }, []);

  const checkForUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      const available = await check();
      if (available) {
        setUpdate(available);
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
      // Don't show error to user for automatic checks
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

  // Don't render if no update, dismissed, or still checking
  if (!update || dismissed || checking) {
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
      {error && <div className="update-error">{error}</div>}
    </div>
  );
}
