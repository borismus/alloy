import { useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { openInEditor, type ExternalEditor } from '../utils/openInEditor';
import { vaultService } from '../services/vault';
import { isTauri } from '../services/api';
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
  externalEditor: ExternalEditor;
  onExternalEditorChange: (value: ExternalEditor) => void;
}

export function Settings({ onClose, vaultPath, externalEditor, onExternalEditorChange }: SettingsProps) {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | CheckResult>('idle');
  const [copiedUrl, setCopiedUrl] = useState(false);

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
        alert('Vault path not set');
        return;
      }
      await revealItemInDir(vaultPath);
    } catch (error) {
      console.error('Failed to reveal vault in Finder:', error);
      alert(`Failed to reveal in Finder: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const handleResetVault = () => {
    localStorage.clear();
    window.location.reload();
  };

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

  const handleCopyShareUrl = async () => {
    if (!shareStatus?.url) return;
    try {
      await navigator.clipboard.writeText(shareStatus.url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1500);
    } catch (e) {
      console.error('[Settings] copy url failed:', e);
    }
  };

  const handleEditConfig = async () => {
    try {
      const filePath = await vaultService.getConfigFilePath();

      if (!filePath) {
        alert('Config file not found in vault');
        return;
      }

      await openInEditor(filePath, externalEditor);
    } catch (error) {
      console.error('Failed to open config file:', error);
      alert(`Failed to open config: ${error instanceof Error ? error.message : String(error)}`);
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
              <p className="vault-path" title={vaultPath} dir="rtl">{vaultPath}</p>
            )}
            <div className="settings-button-group">
              <button
                onClick={handleRevealVaultInFinder}
                className="settings-button settings-button-secondary"
              >
                Reveal in Finder
              </button>
            </div>
          </div>

          <div className="settings-section">
            <h3>Configuration</h3>
            <p className="settings-description">API keys, providers, and preferences.</p>
            <div className="settings-button-group">
              <button
                onClick={handleEditConfig}
                className="settings-button settings-button-secondary"
              >
                Edit config.yaml
              </button>
            </div>
          </div>

          <div className="settings-section">
            <h3>External editor</h3>
            <p className="settings-description">
              Where the "Edit" buttons open notes and vault files. Obsidian opens
              markdown notes in your vault; other files always use the system default.
            </p>
            <select
              className="settings-select"
              value={externalEditor}
              onChange={(e) => onExternalEditorChange(e.target.value as ExternalEditor)}
            >
              <option value="obsidian">Obsidian</option>
              <option value="system">System default editor</option>
            </select>
          </div>

          {isTauri() && shareStatus && (
            <div className="settings-section">
              <div className="settings-row">
                <div className="settings-row-text">
                  <h3>Share on network</h3>
                  <p className="settings-description">
                    Let other devices on your LAN or Tailnet open this vault in a browser.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={shareStatus.enabled}
                  aria-label="Share on network"
                  onClick={handleToggleShare}
                  disabled={shareBusy || !shareStatus.vault_configured}
                  title={!shareStatus.vault_configured ? 'Pick a vault first' : undefined}
                  className={`toggle-switch ${shareStatus.enabled ? 'is-on' : ''}`}
                >
                  <span className="toggle-switch-thumb" />
                </button>
              </div>
              {!shareStatus.vault_configured && (
                <p className="settings-hint">Pick a vault first to enable sharing.</p>
              )}
              {shareStatus.enabled && shareStatus.url && (
                <div className="share-url">
                  <code>{shareStatus.url}</code>
                  <button
                    type="button"
                    onClick={handleCopyShareUrl}
                    className="share-url-copy"
                  >
                    {copiedUrl ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="settings-section">
            <h3>Updates</h3>
            <p className="settings-description">Check for new versions of Alloy.</p>
            <div className="settings-button-group">
              <button
                onClick={handleCheckForUpdates}
                className="settings-button settings-button-secondary"
                disabled={updateStatus === 'checking'}
              >
                {updateStatus === 'checking' ? 'Checking…' : 'Check for updates'}
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

          <div className="settings-section settings-section-danger">
            <h3>Danger zone</h3>
            <p className="settings-description">
              Clears local app state (selected vault, UI prefs) and reloads. Vault files are not deleted.
            </p>
            <div className="settings-button-group">
              <button
                onClick={() => setShowResetConfirm(true)}
                className="settings-button settings-button-danger-outline"
              >
                Reset local state
              </button>
            </div>
          </div>

        </div>
      </div>

      {showResetConfirm && (
        <div className="settings-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="settings-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Reset local app state?</h3>
            <p>The app will reload. You'll be asked to pick a vault again.</p>
            <ul className="confirm-list">
              <li className="confirm-list-clear">
                <span className="confirm-list-icon" aria-hidden>×</span>
                <span>Selected vault, sidebar state, UI preferences</span>
              </li>
              <li className="confirm-list-keep">
                <span className="confirm-list-icon" aria-hidden>✓</span>
                <span>Conversations, notes, tasks, config (all vault files)</span>
              </li>
            </ul>
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
