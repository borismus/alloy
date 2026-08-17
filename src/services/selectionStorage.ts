import type { SelectedItem } from '../types';

/**
 * Persistence for "what was I looking at".
 *
 * Uses localStorage, NOT sessionStorage. sessionStorage is scoped to a single
 * tab session and is discarded when that session ends — which is exactly what
 * iOS does to a backgrounded tab, and what happens when the desktop app
 * restarts. So the selection was reliably lost precisely when restoring it
 * mattered most. The vault path and theme preference already live in
 * localStorage for the same reason.
 *
 * Trade-off: two windows/tabs on the same machine now share a last-selection
 * rather than each keeping its own. Losing your place on every relaunch is the
 * worse of the two.
 */

const KEY = 'alloy.selectedItem';
/** Where this used to live; read once so an in-flight session isn't disrupted. */
const LEGACY_KEY = 'selectedItem';

export function loadSelectedItem(): SelectedItem {
  try {
    const stored = localStorage.getItem(KEY) ?? sessionStorage.getItem(LEGACY_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as SelectedItem;
    // Guard against hand-edited or stale shapes rather than letting a bad value
    // crash startup — losing the selection is recoverable, failing to boot isn't.
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSelectedItem(item: SelectedItem): void {
  try {
    if (item) localStorage.setItem(KEY, JSON.stringify(item));
    else localStorage.removeItem(KEY);
    // Drop the old copy so the two can't disagree later.
    sessionStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage unavailable (private mode, quota) — the selection just won't persist.
  }
}
