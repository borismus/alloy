/**
 * Browser-only mode detection and constants
 *
 * This module provides utilities for detecting whether the app is running
 * inside Tauri (native) or in a browser (mock mode).
 */

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

export const isBrowser = (): boolean => !isTauri();

export const DEMO_VAULT_PATH = '/demo-vault';
