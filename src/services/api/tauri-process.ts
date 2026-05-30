/**
 * Runtime-aware shim for @tauri-apps/plugin-process.
 *
 * Inside Tauri, forwards to the real plugin via direct `invoke` so the app
 * can relaunch itself (needed to apply updates). In a pure browser it falls
 * back to reloading/closing the page.
 *
 * NOTE: must never `import '@tauri-apps/plugin-process'` — vite.config.ts
 * aliases that specifier back to this file, which would loop.
 */

import { isTauri } from './index';

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

export async function relaunch(): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('plugin:process|restart');
    return;
  }
  window.location.reload();
}

export async function exit(code = 0): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('plugin:process|exit', { code });
    return;
  }
  window.close();
}
