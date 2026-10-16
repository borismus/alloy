/**
 * Per-device switch for the viewport debug overlay.
 *
 * Stored in localStorage rather than config.yaml: the vault is synced, and the
 * overlay is for chasing a layout bug on one device (usually a phone) without
 * turning it on everywhere.
 */

const STORAGE_KEY = 'alloy.debugOverlay';

/** Fired when the switch flips, so the overlay appears without a reload. */
export const DEBUG_OVERLAY_CHANGED = 'alloy:debug-overlay-changed';

export function getDebugOverlay(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage unavailable (private mode, etc.) — overlay stays off.
    return false;
  }
}

export function setDebugOverlay(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Non-fatal: the switch still applies until reload.
  }
  window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_CHANGED, { detail: enabled }));
}
