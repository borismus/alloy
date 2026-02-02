/**
 * Mock implementation of @tauri-apps/plugin-dialog
 *
 * Auto-selects demo vault path in browser mode.
 * In server mode, returns vault path from env.
 */

import { DEMO_VAULT_PATH, isServerMode, getVaultPath } from './index';

interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function open(
  _options?: OpenDialogOptions
): Promise<string | string[] | null> {
  if (isServerMode()) {
    // In server mode, return the configured vault path
    const vaultPath = getVaultPath();
    console.log('[MockDialog] open() called in server mode, returning:', vaultPath);
    return vaultPath || '/';
  }

  // In browser mode, always return the demo vault path
  console.log('[MockDialog] open() called, returning demo vault path');
  return DEMO_VAULT_PATH;
}

export async function save(
  _options?: OpenDialogOptions
): Promise<string | null> {
  console.log('[MockDialog] save() called, returning null');
  return null;
}

export async function message(
  msg: string,
  _options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<void> {
  console.log('[MockDialog] message:', msg);
  alert(msg);
}

export async function ask(
  msg: string,
  _options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  console.log('[MockDialog] ask:', msg);
  return confirm(msg);
}

export async function confirm(
  msg: string,
  _options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  console.log('[MockDialog] confirm:', msg);
  return window.confirm(msg);
}
