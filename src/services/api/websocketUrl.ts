/** Resolve an HTTP API base to an absolute WebSocket endpoint URL. */
export function buildWatchWebSocketUrl(apiBase: string, pageOrigin: string): string {
  const httpUrl = new URL(`${apiBase.replace(/\/$/, '')}/api/watch`, pageOrigin);
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return httpUrl.toString();
}
