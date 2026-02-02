/**
 * Mode detection and constants
 *
 * This module provides utilities for detecting whether the app is running:
 * - Tauri (native desktop) - uses Tauri IPC for filesystem
 * - Server mode (web against server) - uses HTTP API for filesystem
 * - Browser mode (demo) - uses in-memory mock filesystem
 */

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

export const isServerMode = (): boolean => {
  // SERVER_MODE can be set explicitly, or inferred from VITE_API_URL
  return !isTauri() && (import.meta.env.VITE_SERVER_MODE === 'true' || !!import.meta.env.VITE_API_URL);
};

export const isBrowser = (): boolean => !isTauri() && !isServerMode();

export const DEMO_VAULT_PATH = '/demo-vault';

// Get the vault path - in server mode, this comes from env
export const getVaultPath = (): string => {
  if (isServerMode()) {
    return import.meta.env.VITE_VAULT_PATH || '';
  }
  return DEMO_VAULT_PATH;
};
