/**
 * Mock implementation of @tauri-apps/plugin-dialog
 *
 * Returns vault path from env in server mode.
 */

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
  const vaultPath = import.meta.env.VITE_VAULT_PATH || '/';
  return vaultPath;
}

export async function save(
  _options?: OpenDialogOptions
): Promise<string | null> {
  return null;
}

export async function message(
  msg: string,
  _options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<void> {
  alert(msg);
}

export async function ask(
  msg: string,
  _options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  return confirm(msg);
}

export async function confirm(
  msg: string,
  _options?: { title?: string; type?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  return window.confirm(msg);
}
