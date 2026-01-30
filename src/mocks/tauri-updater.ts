/**
 * Mock implementation of @tauri-apps/plugin-updater
 *
 * Always returns "no update available" in browser mode.
 */

export interface Update {
  version: string;
  date: string;
  body: string;
  downloadAndInstall: () => Promise<void>;
}

export async function check(): Promise<Update | null> {
  console.log('[MockUpdater] check() - no updates in browser mode');
  return null;
}
