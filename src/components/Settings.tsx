import { useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { vaultService } from '../services/vault';
import { CheckResult } from './UpdateChecker';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
  vaultPath: string | null;
}

export function Settings({ onClose, vaultPath }: SettingsProps) {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | CheckResult>('idle');

  const handleCheckForUpdates = async () => {
    setUpdateStatus('checking');
    const result = await (window as any).checkForUpdates?.();
    if (result) {
      setUpdateStatus(result);
    } else {
      setUpdateStatus('idle');
    }
  };

  const handleRevealVaultInFinder = async () => {
    try {
      if (!vaultPath) {
        console.error('Vault path not found');
        return;
      }
      await revealItemInDir(vaultPath);
    } catch (error) {
      console.error('Failed to reveal vault in Finder:', error);
    }
  };

  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const handleResetVault = () => {
    localStorage.clear();
    window.location.reload();
  };

  const handleEditConfig = async () => {
    try {
      const filePath = await vaultService.getConfigFilePath();

      if (!filePath) {
        console.error('Config file path not found');
        return;
      }

      await openPath(filePath);
    } catch (error) {
      console.error('Failed to open config file:', error);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose} className="close-button">×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Vault</h3>
            <p className="settings-description">All conversations, notes, and settings are stored here.</p>
            {vaultPath && (
              <p className="vault-path">{vaultPath}</p>
            )}
            <div className="settings-button-group">
              <button
                onClick={handleRevealVaultInFinder}
                className="settings-button"
              >
                Reveal in Finder
              </button>
              <button
                onClick={() => setShowResetConfirm(true)}
                className="settings-button settings-button-danger"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="settings-section">
            <h3>Configuration</h3>
            <p className="settings-description">API keys, providers, and preferences.</p>
            <button
              onClick={handleEditConfig}
              className="settings-button"
            >
              Edit config.yaml
            </button>
          </div>

          <div className="settings-section">
            <h3>Updates</h3>
            <p className="settings-description">Check for new versions of Wheelhouse.</p>
            <div className="settings-button-group">
              <button
                onClick={handleCheckForUpdates}
                className="settings-button"
                disabled={updateStatus === 'checking'}
              >
                {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
              </button>
              {updateStatus !== 'idle' && updateStatus !== 'checking' && (
                <span className={`update-status ${
                  'error' in updateStatus ? 'update-status-error' :
                  updateStatus.available ? 'update-status-available' : 'update-status-current'
                }`}>
                  {'error' in updateStatus
                    ? `Error: ${updateStatus.error}`
                    : updateStatus.available
                      ? `Version ${updateStatus.version} available`
                      : 'You\'re up to date'}
                </span>
              )}
            </div>
          </div>

        </div>
      </div>

      {showResetConfirm && (
        <div className="settings-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="settings-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Reset Wheelhouse?</h3>
            <p>This will clear all local settings and reload the app. Your vault files will not be deleted.</p>
            <div className="settings-button-group">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="settings-button settings-button-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleResetVault}
                className="settings-button settings-button-danger"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
