import { useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { openInEditor, type ExternalEditor } from '../utils/openInEditor';
import { vaultService } from '../services/vault';
import { isTauri } from '../services/api';
import { useTheme, type ThemePreference } from '../theme';
import { AlloyDialog, Switch } from './ui';
import { CheckResult } from './UpdateChecker';
import { getApiBase, getAuthHeadersForApi } from '../services/server-streaming';
import { getAutoUpdate, setAutoUpdate } from '../services/autoUpdate';
import packageInfo from '../../package.json';
import './Settings.css';

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

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

interface SchedulerStatus {
  scheduledTaskRunner?: string;
  currentHost?: string;
  schedulerActive?: boolean;
}

interface SettingsProps {
  onClose: () => void;
  vaultPath: string | null;
  externalEditor: ExternalEditor;
  onExternalEditorChange: (value: ExternalEditor) => void;
}

export function Settings({ onClose, vaultPath, externalEditor, onExternalEditorChange }: SettingsProps) {
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | CheckResult>('idle');
  const [autoUpdate, setAutoUpdateState] = useState(getAutoUpdate);
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
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    tauriInvoke<ShareStatus>('get_share_status')
      .then(setShareStatus)
      .catch((e) => console.warn('[Settings] get_share_status failed:', e));
  }, []);

  useEffect(() => {
    if (!vaultPath) return;
    fetch(`${getApiBase()}/api/config`, { headers: getAuthHeadersForApi() })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<SchedulerStatus | null>;
      })
      .then(setSchedulerStatus)
      .catch((e) => console.warn('[Settings] scheduler status failed:', e));
  }, [vaultPath]);

  const handleAssignScheduler = async () => {
    const host = schedulerStatus?.currentHost;
    if (!host || schedulerBusy) return;
    setSchedulerBusy(true);
    try {
      await vaultService.updateConfigValue('scheduledTaskRunner', host);
      setSchedulerStatus(previous => previous ? {
        ...previous,
        scheduledTaskRunner: host,
        schedulerActive: false,
      } : previous);
    } catch (e) {
      console.error('[Settings] scheduled task runner update failed:', e);
      alert(`Failed to assign scheduled tasks: ${e}`);
    } finally {
      setSchedulerBusy(false);
    }
  };

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
    <>
      <AlloyDialog isOpen onOpenChange={(o) => { if (!o) onClose(); }} title="Settings">
        {() => (
        <div className="settings-content">
          <div className="settings-section">
            <h3>Appearance</h3>
            <p className="settings-description">Choose how Alloy looks. System follows your device setting.</p>
            <div className="settings-theme-group" role="group" aria-label="Theme">
              {THEME_OPTIONS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-theme-option ${themePreference === id ? 'is-active' : ''}`}
                  aria-pressed={themePreference === id}
                  onClick={() => setThemePreference(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

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

          {schedulerStatus?.currentHost && (
            <div className="settings-section">
              <h3>Scheduled tasks</h3>
              {schedulerStatus.scheduledTaskRunner ? (
                schedulerStatus.scheduledTaskRunner === schedulerStatus.currentHost ? (
                  <p className="settings-description">
                    This machine, <strong>{schedulerStatus.currentHost}</strong>, runs this vault&apos;s scheduled tasks.
                  </p>
                ) : (
                  <p className="settings-description">
                    Scheduled tasks run on <strong>{schedulerStatus.scheduledTaskRunner}</strong>. This server is{' '}
                    <strong>{schedulerStatus.currentHost}</strong>.
                  </p>
                )
              ) : (
                <p className="settings-description settings-warning">
                  No runner is assigned. Every Alloy machine using this vault may execute the same task.
                </p>
              )}
              {schedulerStatus.scheduledTaskRunner === schedulerStatus.currentHost &&
               schedulerStatus.schedulerActive === false && (
                <p className="settings-hint">
                  Assignment saved. Activation can take up to a minute; if this persists, another Alloy process
                  on this machine holds the scheduler lock.
                </p>
              )}
              {schedulerStatus.scheduledTaskRunner !== schedulerStatus.currentHost && (
                <div className="settings-button-group">
                  <button
                    type="button"
                    onClick={handleAssignScheduler}
                    className="settings-button settings-button-secondary"
                    disabled={schedulerBusy}
                  >
                    {schedulerBusy ? 'Assigning…' : 'Run scheduled tasks on this machine'}
                  </button>
                </div>
              )}
              <p className="settings-hint">
                The assignment is stored in the shared vault. Run now remains available from every Alloy server.
              </p>
            </div>
          )}

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
                <Switch
                  aria-label="Share on network"
                  isSelected={shareStatus.enabled}
                  onChange={handleToggleShare}
                  isDisabled={shareBusy || !shareStatus.vault_configured}
                />
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
            <p className="settings-description">
              Current version: <span className="settings-version">{packageInfo.version}</span>
            </p>
            {isTauri() && (
              <>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <p className="settings-description">
                      Install updates automatically on launch
                    </p>
                  </div>
                  <Switch
                    aria-label="Install updates automatically"
                    isSelected={autoUpdate}
                    onChange={(v) => { setAutoUpdateState(v); setAutoUpdate(v); }}
                  />
                </div>
                <p className="settings-hint">
                  Applies to this machine only, not your other devices. Useful for an
                  always-on Mac that shares Alloy on the network; updates install at
                  startup, never mid-session.
                </p>
              </>
            )}
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
        )}
      </AlloyDialog>

      {showResetConfirm && (
        <AlloyDialog
          isOpen
          onOpenChange={(o) => { if (!o) setShowResetConfirm(false); }}
          size="compact"
          title="Reset local app state?"
        >
          {() => (
            <div className="dialog-body">
              <p className="settings-description">The app will reload. You'll be asked to pick a vault again.</p>
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
          )}
        </AlloyDialog>
      )}
    </>
  );
}
