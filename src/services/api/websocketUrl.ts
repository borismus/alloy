/**
 * Resolve an HTTP API base to an absolute WebSocket endpoint URL.
 *
 * Builds the ws:/wss: URL by hand rather than assigning `.protocol`. Under
 * Tauri the page origin is `tauri://localhost`, and the URL spec IGNORES a
 * protocol assignment that would turn a non-special scheme into a special one —
 * silently leaving `tauri://localhost/api/watch`, which WebKit then rejects with
 * "SyntaxError: The string did not match the expected pattern." That surfaced as
 * a baffling error whenever the embedded server had no vault bound yet (empty
 * api base), masking the real failure.
 *
 * Returns null when no usable ws:/wss: URL can be formed, so callers can skip
 * the watcher instead of throwing.
 */
export function buildWatchWebSocketUrl(apiBase: string, pageOrigin: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(`${apiBase.replace(/\/$/, '')}/api/watch`, pageOrigin);
  } catch {
    return null;
  }
  // Only http(s) origins can host a WebSocket. Anything else (tauri:, file:)
  // means we don't yet know the server's real address.
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  const scheme = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${resolved.host}${resolved.pathname}${resolved.search}`;
}
