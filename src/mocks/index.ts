/**
 * Mode detection utilities
 *
 * Detects whether the app is running:
 * - Tauri (native desktop) - uses Tauri IPC for filesystem
 * - Server mode (web) - uses HTTP API for filesystem
 */

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

export const isServerMode = (): boolean => {
  return !isTauri();
};
