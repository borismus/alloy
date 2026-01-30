/**
 * Mock implementation of @tauri-apps/plugin-process
 *
 * Uses page reload as fallback for relaunch.
 */

export async function relaunch(): Promise<void> {
  console.log('[MockProcess] relaunch() - using page reload');
  window.location.reload();
}

export async function exit(_code?: number): Promise<void> {
  console.log('[MockProcess] exit() - closing window');
  window.close();
}
