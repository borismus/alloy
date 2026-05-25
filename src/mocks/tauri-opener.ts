/**
 * Runtime-aware mock for @tauri-apps/plugin-opener.
 *
 * In Tauri, forwards to the real plugin via direct `invoke` (bypassing the
 * JS plugin to avoid the alias loop). In a pure browser, uses window.open
 * for URLs and falls back to clipboard for filesystem reveal.
 */

import { isTauri } from './index';

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

export async function openUrl(url: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('plugin:opener|open_url', { url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openPath(path: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('plugin:opener|open_path', { path });
    return;
  }
  // No-op in browser — can't open filesystem paths.
}

export async function revealItemInDir(path: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('plugin:opener|reveal_item_in_dir', { path });
    return;
  }
  // Browser fallback: copy the path to clipboard so the user can find it.
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    // Ignore — best-effort.
  }
}
