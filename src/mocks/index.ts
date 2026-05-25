/**
 * Mode detection utilities.
 *
 * - `isTauri()`: window detection — true whenever the Tauri runtime is in
 *   the page, regardless of build config.
 * - `isServerMode()`: true when the SPA should talk to an HTTP backend
 *   (either a standalone alloy-serve or the embedded Tauri server). Set at
 *   build time via the `SERVER_MODE` env var (also set by Tauri builds in
 *   Phase 2 via TAURI=true → SERVER_MODE=true). Falls back to "not Tauri"
 *   for the legacy path.
 */

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

export const isServerMode = (): boolean => {
  // Vite injects this when SERVER_MODE=true was set at build time.
  if (import.meta.env.VITE_SERVER_MODE === 'true') return true;
  return !isTauri();
};
