import { useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { openInEditor, type ExternalEditor } from '../utils/openInEditor';
import { vaultService } from '../services/vault';
import { isTauri } from '../services/api';
import { useTheme, type ThemePreference } from '../theme';
import { AlloyDialog, Button, CopyButton, DialogActions, DialogBody, SegmentedControl, SelectField, Switch } from './ui';
import { CheckResult } from './UpdateChecker';
import { getApiBase, getAuthHeadersForApi } from '../services/server-streaming';
import { getAutoUpdate, loadAutoUpdate, setAutoUpdate } from '../services/autoUpdate';
import { getDebugOverlay, setDebugOverlay } from '../services/debugOverlay';
import packageInfo from '../../package.json';
import './Settings.css';

const EDITOR_OPTIONS: { id: ExternalEditor; label: string }[] = [
  { id: 'obsidian', label: 'Obsidian' },
  { id: 'system', label: 'System default editor' },
];

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
  // Seed from the local mirror so the switch renders immediately, then confirm
  // against the shell, which holds the authoritative per-machine value.
  const [autoUpdate, setAutoUpdateState] = useState(getAutoUpdate);
  useEffect(() => {
    let cancelled = false;
    void loadAutoUpdate().then((enabled) => {
      if (!cancelled) setAutoUpdateState(enabled);
    });
    return () => { cancelled = true; };
  }, []);
  const [debugOverlay, setDebugOverlayState] = useState(getDebugOverlay);

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
            <div className="settings-theme-group">
              <SegmentedControl
                aria-label="Theme"
                options={THEME_OPTIONS}
                value={themePreference}
                onChange={(id) => setThemePreference(id as ThemePreference)}
              />
            </div>
          </div>

          {/* Vault location, config.yaml and the external editor all act on files
              on the machine running Alloy, so they only work in the desktop app. */}
          {isTauri() && (
          <>
          <div className="settings-section">
            <h3>Vault</h3>
            <p className="settings-description">All conversations, notes, and settings are stored here.</p>
            {vaultPath && (
              <p className="vault-path" title={vaultPath} dir="rtl">{vaultPath}</p>
            )}
            <div className="settings-button-group">
              <Button variant="secondary" size="small" onPress={handleRevealVaultInFinder}>
                Reveal in Finder
              </Button>
            </div>
          </div>

          <div className="settings-section">
            <h3>Configuration</h3>
            <p className="settings-description">API keys, providers, and preferences.</p>
            <div className="settings-button-group">
              <Button variant="secondary" size="small" onPress={handleEditConfig}>
                Edit config.yaml
              </Button>
            </div>
          </div>
          </>
          )}

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
                    Scheduled tasks run on <strong>{schedulerStatus.scheduledTaskRunner}</strong>. You&apos;re connected to{' '}
                    <strong>{schedulerStatus.currentHost}</strong>.
                  </p>
                )
              ) : (
                <p className="settings-description">
                  No machine is set to run scheduled tasks yet. Pick one so each task runs once, rather than
                  on every machine that uses this vault.
                </p>
              )}
              {schedulerStatus.scheduledTaskRunner === schedulerStatus.currentHost &&
               schedulerStatus.schedulerActive === false && (
                <p className="settings-hint">
                  Saved. It can take up to a minute to start. If it doesn&apos;t, another copy of Alloy on this
                  machine is already running the schedule.
                </p>
              )}
              {schedulerStatus.scheduledTaskRunner !== schedulerStatus.currentHost && (
                <div className="settings-button-group">
                  <Button
                    variant="secondary"
                    size="small"
                    onPress={handleAssignScheduler}
                    isDisabled={schedulerBusy}
                  >
                    {schedulerBusy ? 'Assigning…' : 'Run scheduled tasks on this machine'}
                  </Button>
                </div>
              )}
              <p className="settings-hint">
                Saved in your vault, so every device sees the same choice. Run now works from any device.
              </p>
            </div>
          )}

          {isTauri() && (
          <div className="settings-section">
            <h3>External editor</h3>
            <p className="settings-description">
              Where the "Edit" buttons open notes and vault files. Obsidian opens
              markdown notes in your vault; other files always use the system default.
            </p>
            <SelectField
              label="Open files with"
              value={externalEditor}
              options={EDITOR_OPTIONS}
              onChange={(value) => onExternalEditorChange(value as ExternalEditor)}
            />
          </div>
          )}

          {isTauri() && shareStatus && (
            <div className="settings-section">
              <div className="settings-row">
                <div className="settings-row-text">
                  <h3>Share on network</h3>
                  <p className="settings-description">
                    Let your other devices open this vault in a browser over Tailscale, or through a tunnel running on this computer. Other network connections are refused.
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
                  <CopyButton text={shareStatus.url} />
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
                      Install updates automatically when idle
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
                  always-on Mac that shares Alloy on the network. Alloy checks
                  periodically and restarts to apply an update only when no
                  conversation or scheduled task is running.
                </p>
              </>
            )}
            {!isTauri() ? (
              // The browser build is served by the Mac running Alloy; it can't
              // check for or install updates itself.
              <p className="settings-hint">Updates install on the machine that runs Alloy.</p>
            ) : (
            <div className="settings-button-group">
              <Button
                variant="secondary"
                size="small"
                onPress={handleCheckForUpdates}
                isDisabled={updateStatus === 'checking'}
              >
                {updateStatus === 'checking' ? 'Checking…' : 'Check for updates'}
              </Button>
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
            )}
          </div>

          <div className="settings-section">
            <div className="settings-row">
              <div className="settings-row-text">
                <h3>Diagnostics</h3>
                <p className="settings-description">
                  Viewport debug overlay: live viewport measurements, and a dot where each tap registers.
                </p>
              </div>
              <Switch
                aria-label="Viewport debug overlay"
                isSelected={debugOverlay}
                onChange={(v) => { setDebugOverlayState(v); setDebugOverlay(v); }}
              />
            </div>
            <p className="settings-hint">Applies to this device only. Holding the settings button also turns it on or off.</p>
          </div>

          <div className="settings-section settings-section-danger">
            <h3>Danger zone</h3>
            <p className="settings-description">
              Clears local app state (selected vault, UI prefs) and reloads. Vault files are not deleted.
            </p>
            <div className="settings-button-group">
              <Button variant="dangerText" size="small" onPress={() => setShowResetConfirm(true)}>
                Reset local state
              </Button>
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
            <DialogBody>
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
              <DialogActions>
                <Button variant="secondary" onPress={() => setShowResetConfirm(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onPress={handleResetVault}>
                  Reset
                </Button>
              </DialogActions>
            </DialogBody>
          )}
        </AlloyDialog>
      )}
    </>
  );
}
