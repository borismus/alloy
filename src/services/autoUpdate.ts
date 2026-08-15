/**
 * Per-machine "install updates automatically" preference.
 *
 * Deliberately stored in localStorage rather than config.yaml: the vault is
 * synced between machines, so a vault-level flag would force the same behavior
 * everywhere. The case this exists for is the opposite — an always-on box
 * serving Alloy to other devices should update itself, while the laptop you are
 * actively working on should not restart under you.
 */

const STORAGE_KEY = 'alloy.autoUpdate';

export function getAutoUpdate(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage unavailable (private mode, etc.) — treat as opt-out.
    return false;
  }
}

export function setAutoUpdate(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Non-fatal: the preference simply won't persist.
  }
}
