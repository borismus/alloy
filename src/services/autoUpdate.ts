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

import { getApiBase, getAuthHeadersForApi } from './server-streaming';

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

interface ServerActivity {
  busy: boolean;
  streamingSessions: number;
  runningTasks: number;
}

/**
 * Ask the backend whether anything is in flight. The frontend cannot answer
 * this: a turn may belong to another device on the LAN, and scheduled tasks run
 * with no client attached.
 *
 * Any doubt counts as busy. An unreachable or unparseable server must never be
 * read as "safe to restart" — the cost of waiting is a delayed update, the cost
 * of guessing wrong is killing a running task.
 */
export async function isServerIdle(): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBase()}/api/activity`, {
      headers: getAuthHeadersForApi(),
    });
    if (!response.ok) return false;
    const activity = await response.json() as ServerActivity;
    return activity.busy === false;
  } catch {
    return false;
  }
}

export type AutoUpdateOutcome =
  | 'disabled'
  | 'none'
  | 'busy-before-install'
  | 'busy-after-install'
  | 'installed'
  | 'error';

export interface AutoUpdateDeps<TUpdate> {
  /** Per-machine opt-in, re-read each cycle so toggling it takes effect. */
  enabled: () => boolean;
  findUpdate: () => Promise<TUpdate | null>;
  isIdle: () => Promise<boolean>;
  install: (update: TUpdate) => Promise<void>;
  relaunch: () => Promise<void>;
  /** True when a previous cycle installed but had to defer the relaunch. */
  pendingInstall?: boolean;
}

/**
 * One unattended update attempt.
 *
 * Idle is checked twice on purpose. Once before downloading, so a busy machine
 * does no work at all; and again immediately before relaunching, because a turn
 * or scheduled task can start while the download runs. Nothing here ever
 * cancels work or imposes a deadline on it — a busy machine simply defers, and
 * the caller retries later.
 */
export async function runAutoUpdateCycle<TUpdate>(
  deps: AutoUpdateDeps<TUpdate>,
): Promise<AutoUpdateOutcome> {
  if (!deps.enabled()) return 'disabled';

  // A previous cycle already staged the bytes; only the restart is outstanding,
  // so don't download them again.
  if (deps.pendingInstall) {
    if (!await deps.isIdle()) return 'busy-after-install';
    await deps.relaunch();
    return 'installed';
  }

  let update: TUpdate | null;
  try {
    update = await deps.findUpdate();
  } catch {
    return 'error';
  }
  if (!update) return 'none';

  if (!await deps.isIdle()) return 'busy-before-install';

  try {
    await deps.install(update);
  } catch {
    return 'error';
  }

  if (!await deps.isIdle()) return 'busy-after-install';

  await deps.relaunch();
  return 'installed';
}
