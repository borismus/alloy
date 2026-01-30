/**
 * Mock implementation of @tauri-apps/plugin-dialog
 *
 * Auto-selects demo vault path in browser mode.
 */

import { DEMO_VAULT_PATH } from './index';

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
