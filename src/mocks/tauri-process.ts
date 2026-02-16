/**
 * Mock implementation of @tauri-apps/plugin-process
 *
 * Uses page reload as fallback for relaunch.
 */

export async function relaunch(): Promise<void> {
  window.location.reload();
}

export async function exit(_code?: number): Promise<void> {
  window.close();
}
