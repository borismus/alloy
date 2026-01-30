/**
 * Mock implementation of @tauri-apps/plugin-opener
 *
 * Uses window.open for URLs, no-ops for file operations.
 */

export async function openUrl(url: string): Promise<void> {
  console.log('[MockOpener] openUrl:', url);
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openPath(_path: string): Promise<void> {
  console.log('[MockOpener] openPath (no-op in browser):', _path);
  // No-op in browser - can't open filesystem paths
}

export async function revealItemInDir(_path: string): Promise<void> {
  console.log('[MockOpener] revealItemInDir (no-op in browser):', _path);
  // No-op in browser - can't reveal in file manager
}
