/**
 * Per-machine "install updates automatically" preference, and the policy for
 * applying one without interrupting work.
 *
 * Deliberately stored in localStorage rather than config.yaml: the vault is
 * synced between machines, so a vault-level flag would force the same behavior
 * everywhere. The case this exists for is the opposite — an always-on box
 * serving Alloy to other devices should update itself, while the laptop you are
 * actively working on should not restart under you.
 */

import { isTauri } from './api';

const STORAGE_KEY = 'alloy.autoUpdate';

/**
 * Fired when the preference changes, so the updater can react at once instead of
 * waiting out its polling interval. Turning a setting on should visibly do
 * something; without this, enabling it looked inert for up to a full cycle.
 */
export const AUTO_UPDATE_CHANGED = 'alloy:auto-update-changed';

/**
 * Read the preference for display. The desktop shell owns the authoritative
 * copy — it must be readable before any window exists, and clearing webview
 * storage must not silently opt a machine out — so localStorage is only a
 * mirror for rendering the switch, and a browser-mode fallback.
 */
export function getAutoUpdate(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage unavailable (private mode, etc.) — treat as opt-out.
    return false;
  }
}

/**
 * Authoritative value from the shell, falling back to the local mirror.
 *
 * Also carries a pre-0.4.29 preference across. The setting used to live only in
 * localStorage; when it moved into the shell, an upgraded machine found no file
 * and defaulted to off — so a box that had been told to keep itself current
 * silently stopped, having applied that very update. `configured` is what makes
 * this safe: it migrates only when the shell has never been told either way, so
 * a deliberate opt-out is never overridden.
 */
export async function loadAutoUpdate(): Promise<boolean> {
  if (!isTauri()) return getAutoUpdate();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const state = await invoke<{ enabled: boolean; configured: boolean }>('get_auto_update');
    if (!state.configured && getAutoUpdate()) {
      await invoke('set_auto_update', { enabled: true });
      console.info('[Updater] carried the update preference over to the app');
      return true;
    }
    try {
      localStorage.setItem(STORAGE_KEY, String(state.enabled));
    } catch { /* mirror is best-effort */ }
    return state.enabled;
  } catch {
    return getAutoUpdate();
  }
}

export function setAutoUpdate(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Non-fatal: the preference simply won't persist.
  }
  // Hand it to the shell, which persists it and — when switching on — checks
  // within seconds rather than waiting out its interval.
  if (isTauri()) {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_auto_update', { enabled });
      } catch (error) {
        console.error('[Updater] could not save the update preference:', error);
      }
    })();
  }
  try {
    window.dispatchEvent(new CustomEvent(AUTO_UPDATE_CHANGED, { detail: { enabled } }));
  } catch {
    // No window (tests, SSR): the shell still has the value.
  }
}

// The unattended update loop itself now lives in the desktop shell
// (src-tauri/src/updater.rs), driven by alloy-server's `update_policy`. It ran
// here until macOS timer throttling in a background window made it unreliable
// on exactly the always-on machines it serves, and its decisions went to a
// console unreachable over SSH. Manual checks stay in the UI.
