/**
 * Runtime-aware mock for @tauri-apps/plugin-dialog.
 *
 * When loaded inside Tauri (window has __TAURI_INTERNALS__), forwards to
 * the real Tauri plugin via direct `invoke` — bypassing the JS plugin
 * package to avoid alias-loop with vite.config.ts. In a pure browser,
 * falls back to VITE_VAULT_PATH (folder picker isn't possible).
 */

import { isTauri } from './index';

interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

export async function open(
  options?: OpenDialogOptions
): Promise<string | string[] | null> {
  if (isTauri()) {
    // Tauri 2 dialog plugin command name.
    return tauriInvoke<string | string[] | null>('plugin:dialog|open', {
      options: options ?? {},
    });
  }
  return import.meta.env.VITE_VAULT_PATH || '/';
}

export async function save(
  options?: OpenDialogOptions
): Promise<string | null> {
  if (isTauri()) {
    return tauriInvoke<string | null>('plugin:dialog|save', {
      options: options ?? {},
    });
  }
  return null;
}

export async function message(
  msg: string,
  options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('plugin:dialog|message', {
      message: msg,
      options: options ?? {},
    });
    return;
  }
  alert(msg);
}

export async function ask(
  msg: string,
  options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  if (isTauri()) {
    return tauriInvoke<boolean>('plugin:dialog|ask', {
      message: msg,
      options: options ?? {},
    });
  }
  return confirm(msg);
}

export async function confirm(
  msg: string,
  options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  if (isTauri()) {
    return tauriInvoke<boolean>('plugin:dialog|confirm', {
      message: msg,
      options: options ?? {},
    });
  }
  return window.confirm(msg);
}
