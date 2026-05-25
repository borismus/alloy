import { useEffect, useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { vaultService } from '../services/vault';
import { isTauri } from '../mocks';
import { CheckResult } from './UpdateChecker';
import './Settings.css';

interface ShareStatus {
  enabled: boolean;
  port: number;
  url: string | null;
  vault_configured: boolean;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

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

  // Network sharing (Tauri only). Lets the user expose the embedded server
  // to other devices on the LAN/Tailnet so phones can hit the same vault.
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    tauriInvoke<ShareStatus>('get_share_status')
      .then(setShareStatus)
      .catch((e) => console.warn('[Settings] get_share_status failed:', e));
  }, []);

  const handleToggleShare = async () => {
    if (!shareStatus || shareBusy) return;
    setShareBusy(true);
    try {
      const next = await tauriInvoke<ShareStatus>('set_share_on_network', {
        enabled: !shareStatus.enabled,
      });
      setShareStatus(next);
    } catch (e) {
      console.error('[Settings] set_share_on_network failed:', e);
      alert(`Failed to toggle share: ${e}`);
    } finally {
      setShareBusy(false);
    }
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

          {isTauri() && shareStatus && (
            <div className="settings-section">
              <h3>Network</h3>
              <p className="settings-description">
                Allow other devices on your network to access this Alloy session
                via a browser. Use over Tailscale or LAN only.
              </p>
              <div className="settings-button-group">
                <button
                  onClick={handleToggleShare}
                  className="settings-button"
                  disabled={shareBusy || !shareStatus.vault_configured}
                  title={!shareStatus.vault_configured ? 'Pick a vault first' : undefined}
                >
                  {shareBusy
                    ? '…'
                    : shareStatus.enabled
                      ? `Stop sharing (port ${shareStatus.port})`
                      : `Share on network (port ${shareStatus.port})`}
                </button>
              </div>
              {shareStatus.enabled && shareStatus.url && (
                <p className="vault-path" style={{ marginTop: '8px' }}>
                  Open on your phone: <code>{shareStatus.url}</code>
                </p>
              )}
              {!shareStatus.vault_configured && (
                <p className="settings-description" style={{ marginTop: '4px', fontSize: '12px' }}>
                  Pick a vault first to enable network sharing.
                </p>
              )}
            </div>
          )}

          <div className="settings-section">
            <h3>Updates</h3>
            <p className="settings-description">Check for new versions of Alloy.</p>
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
            <h3>Reset Alloy?</h3>
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
