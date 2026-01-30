/**
 * Mock implementation of @tauri-apps/plugin-http
 *
 * Re-exports native fetch since we're in a browser.
 */

// In browser mode, just use native fetch
export const fetch = window.fetch.bind(window);
