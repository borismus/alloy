/**
 * Mock implementation of @tauri-apps/plugin-opener
 *
 * Uses window.open for URLs.
 * In server mode, copies path to clipboard instead of revealing in file manager.
 */

import { isServerMode } from './index';

export async function openUrl(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openPath(_path: string): Promise<void> {
  // No-op in browser - can't open filesystem paths
}

export async function revealItemInDir(path: string): Promise<void> {
  if (isServerMode()) {
    // In server mode, copy the path to clipboard as a fallback
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      // Failed to copy to clipboard
    }
  }
}
