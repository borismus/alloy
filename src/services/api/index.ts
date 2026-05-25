/**
 * Runtime detection helpers.
 *
 * After Phase 3 the SPA always talks to the backend over HTTP — there's no
 * "Tauri-direct vs server" branching for FS/HTTP anymore. `isTauri()`
 * still exists because a few native-OS operations (folder picker, "reveal
 * in Finder", updater, system menus) only work inside Tauri and have to
 * short-circuit in a pure browser.
 */

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

/**
 * Always true in the post-Phase-3 architecture: the SPA's FS/HTTP path is
 * the same regardless of whether it's loaded in a Tauri webview or a
 * browser. Kept as a function for backward-compatibility with the call
 * sites that haven't been pruned yet.
 */
export const isServerMode = (): boolean => true;
