/**
 * Tauri-mode bootstrap for the embedded alloy-server.
 *
 * Inside Tauri, the embedded Rust server listens on a random loopback port.
 * The SPA needs to ask Tauri what that URL is *before* any FS / streaming /
 * model calls happen. This module is called once from App.tsx init.
 *
 * On first launch, the server has no vault bound yet (`get_server_url`
 * returns null). The SPA's folder-picker flow will then call
 * `setEmbeddedVaultPath` once a vault has been chosen.
 *
 * Outside Tauri (browser SPA hitting a standalone alloy-serve), this module
 * is a no-op — `getEmbeddedApiBase()` falls back to `VITE_API_URL`.
 */

import { isTauri } from './api';

declare global {
  interface Window {
    __ALLOY_API_BASE__?: string;
  }
}

/** Try to load `invoke` from Tauri. Returns null outside Tauri. */
async function getInvoke(): Promise<(<T>(cmd: string, args?: object) => Promise<T>) | null> {
  if (!isTauri()) return null;
  try {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke as <T>(cmd: string, args?: object) => Promise<T>;
  } catch {
    return null;
  }
}

/**
 * Ask the Tauri shell for the embedded server's URL and store it globally.
 * Call once during app init. Returns the URL or null (server not bound yet).
 */
export async function loadEmbeddedServerUrl(): Promise<string | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    const url = await invoke<string | null>('get_server_url');
    if (url) {
      window.__ALLOY_API_BASE__ = url;
    }
    return url;
  } catch (e) {
    console.warn('[tauri-bootstrap] get_server_url failed:', e);
    return null;
  }
}

/**
 * Tell the embedded server which vault to use. Spins up (or rebinds) the
 * axum listener and returns the new URL. Stores the URL globally so
 * subsequent fetches go through it.
 */
export async function setEmbeddedVaultPath(path: string): Promise<string | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    const url = await invoke<string>('set_vault_path', { path });
    window.__ALLOY_API_BASE__ = url;
    return url;
  } catch (e) {
    console.error('[tauri-bootstrap] set_vault_path failed:', e);
    return null;
  }
}

/**
 * Return the API base for fetch() calls. Priority:
 *   1. Embedded server URL set by loadEmbeddedServerUrl/setEmbeddedVaultPath
 *   2. VITE_API_URL env var (set when running SPA against standalone alloy-serve)
 *   3. Empty string (same-origin — Vite proxy handles it in dev)
 */
export function getEmbeddedApiBase(): string {
  if (typeof window !== 'undefined' && window.__ALLOY_API_BASE__) {
    return window.__ALLOY_API_BASE__;
  }
  return (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL || '';
}
