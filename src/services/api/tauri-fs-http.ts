/**
 * HTTP-based implementation of @tauri-apps/plugin-fs
 *
 * Calls the Alloy server API for filesystem operations.
 * Used in SERVER_MODE when running as a web app against a remote server.
 */

import { buildWatchWebSocketUrl } from './websocketUrl';

// Types matching Tauri's fs plugin
export interface WatchEvent {
  type: WatchEventKind;
  paths: string[];
}

export type WatchEventKind =
  | 'any'
  | 'other'
  | { create: { kind: string } }
  | { modify: { kind: string } }
  | { remove: { kind: string } };

interface DirEntry {
  name: string | null;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface FileMetadata {
  mtime: Date | null;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
}

interface WatchOptions {
  recursive?: boolean;
  delayMs?: number;
}

type WatchCallback = (event: WatchEvent) => void;

// API configuration. Inside Tauri the embedded server's URL is injected at
// boot by `src/services/tauri-bootstrap.ts`; in standalone browser mode we
// fall back to VITE_API_URL or same-origin.
const getApiBase = (): string => {
  if (typeof window !== 'undefined' && (window as { __ALLOY_API_BASE__?: string }).__ALLOY_API_BASE__) {
    return (window as { __ALLOY_API_BASE__?: string }).__ALLOY_API_BASE__!;
  }
  return import.meta.env.VITE_API_URL || '';
};
const getAuthToken = () => import.meta.env.VITE_AUTH_TOKEN || '';

async function apiCall<T>(endpoint: string, body: object): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${getApiBase()}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `API error: ${res.status}`);
  }

  return res.json();
}

// Filesystem operations

export async function readTextFile(path: string): Promise<string> {
  const result = await apiCall<{ content: string }>('/api/fs/readTextFile', { path });
  return result.content;
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await apiCall('/api/fs/writeTextFile', { path, content });
}

export async function readFile(path: string): Promise<Uint8Array> {
  const result = await apiCall<{ data: string }>('/api/fs/readFile', { path });
  // Decode base64 to Uint8Array
  const binary = atob(result.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function writeFile(path: string, content: Uint8Array): Promise<void> {
  // Encode Uint8Array to base64
  let binary = '';
  for (let i = 0; i < content.length; i++) {
    binary += String.fromCharCode(content[i]);
  }
  const data = btoa(binary);
  await apiCall('/api/fs/writeFile', { path, data });
}

export async function exists(path: string): Promise<boolean> {
  const result = await apiCall<{ exists: boolean }>('/api/fs/exists', { path });
  return result.exists;
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await apiCall('/api/fs/mkdir', { path, options });
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const result = await apiCall<{ entries: DirEntry[] }>('/api/fs/readDir', { path });
  return result.entries;
}

export async function readDirHeaders(path: string, ext?: string, bytes?: number): Promise<Record<string, { content: string; mtime: number }>> {
  const result = await apiCall<{ files: Record<string, { content: string; mtime: number }> }>('/api/fs/readDirHeaders', { path, ext, bytes });
  return result.files;
}

export async function remove(path: string): Promise<void> {
  await apiCall('/api/fs/remove', { path });
}

export async function stat(path: string): Promise<FileMetadata> {
  const result = await apiCall<{
    mtime: string | null;
    size: number;
    isDirectory: boolean;
    isFile: boolean;
  }>('/api/fs/stat', { path });

  return {
    mtime: result.mtime ? new Date(result.mtime) : null,
    size: result.size,
    isDirectory: result.isDirectory,
    isFile: result.isFile,
  };
}

// WebSocket-based file watching
let ws: WebSocket | null = null;
let wsConnecting = false;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const watchers = new Map<string, Set<WatchCallback>>();

// Callers waiting on an in-flight connect. Settled together when it opens or
// fails, so a failed attempt can't strand them (see `ensureWebSocket`).
let pendingWaiters: Array<{ resolve: (s: WebSocket) => void; reject: (e: Error) => void }> = [];

function settleWaiters(socket: WebSocket | null, error?: Error) {
  const waiters = pendingWaiters;
  pendingWaiters = [];
  for (const w of waiters) {
    if (socket) w.resolve(socket);
    else w.reject(error ?? new Error('WebSocket connection failed'));
  }
}

// Fires when the socket comes back AFTER a previous connection was lost. The
// server pushes live events only; anything that changed while we were gone is
// never replayed, so subscribers use this to re-read the vault and catch up.
// A first-ever connect is NOT a reconnect and does not fire.
type ReconnectCallback = () => void;
const reconnectCallbacks = new Set<ReconnectCallback>();
let hasConnectedBefore = false;

export function onWatchReconnect(callback: ReconnectCallback): () => void {
  reconnectCallbacks.add(callback);
  return () => {
    reconnectCallbacks.delete(callback);
  };
}

function notifyReconnect() {
  for (const cb of reconnectCallbacks) {
    try {
      cb();
    } catch (err) {
      console.error('[WS] Reconnect callback error:', err);
    }
  }
}

function ensureWebSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve(ws);
      return;
    }

    if (wsConnecting) {
      // Queue against the in-flight attempt. Previously this polled on a 100ms
      // interval that was only cleared on success: if the attempt FAILED the
      // interval ran forever and the promise never settled, so `watch()` hung
      // and the watcher was never registered at all.
      pendingWaiters.push({ resolve, reject });
      return;
    }

    wsConnecting = true;

    // Build an ABSOLUTE ws:// URL. In web-dev getApiBase() is '' (same-origin;
    // Vite proxies /api), so bare concatenation would yield the relative string
    // '/api/watch' — which not every engine's WebSocket constructor accepts,
    // leaving the file watcher silently dead (new conversations never appear
    // until reload). Resolve against the page origin like the SSE path does.
    const apiBase = getApiBase();
    const pageOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const wsUrl = buildWatchWebSocketUrl(apiBase, pageOrigin);
    if (!wsUrl) {
      // No usable address yet (embedded server not bound). Fail cleanly rather
      // than constructing an invalid WebSocket, and reset the connecting flag so
      // a later attempt — once the vault is bound — isn't blocked forever.
      wsConnecting = false;
      const error = new Error('No WebSocket URL available (server not bound yet)');
      reject(error);
      settleWaiters(null, error);
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (e) {
      // A synchronous throw here used to leave `wsConnecting` true forever, so
      // every later watch() queued behind a connect that could never complete.
      wsConnecting = false;
      const error = e instanceof Error ? e : new Error(String(e));
      reject(error);
      settleWaiters(null, error);
      return;
    }

    socket.onopen = () => {
      ws = socket;
      wsConnecting = false;
      const isReconnect = hasConnectedBefore;
      hasConnectedBefore = true;
      resolve(socket);
      settleWaiters(socket);
      // Announce after settling so subscribers registered by a queued `watch()`
      // call are in place before the catch-up fires.
      if (isReconnect) notifyReconnect();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WatchEvent;

        // The server emits vault-relative paths (e.g. "conversations/foo.yaml").
        // Client code (useVaultWatcher + markSelfWrite) is written against
        // absolute paths the way native Tauri fs.watch delivers them, so we
        // rebuild absolute paths against each watcher's registered root
        // before dispatching.
        watchers.forEach((callbacks, watchPath) => {
          const absolutePaths = data.paths.map((p) =>
            p.startsWith('/') ? p : `${watchPath.replace(/\/$/, '')}/${p}`
          );
          const adjustedEvent: WatchEvent = { type: data.type, paths: absolutePaths };
          callbacks.forEach((cb) => {
            try {
              cb(adjustedEvent);
            } catch (err) {
              console.error('[WS] Watcher callback error:', err);
            }
          });
        });
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    socket.onclose = () => {
      ws = null;
      const wasConnecting = wsConnecting;
      wsConnecting = false;
      // A close during connect (server refused/closed without an error event)
      // must also release queued callers rather than leaving them hanging.
      if (wasConnecting) settleWaiters(null, new Error('WebSocket closed before opening'));

      // Attempt to reconnect if we have watchers
      if (watchers.size > 0 && !wsReconnectTimer) {
        wsReconnectTimer = setTimeout(() => {
          wsReconnectTimer = null;
          ensureWebSocket().catch(console.error);
        }, 3000);
      }
    };

    socket.onerror = (err) => {
      console.error('[WS] WebSocket error:', err);
      wsConnecting = false;
      const error = new Error('WebSocket connection failed');
      reject(error);
      settleWaiters(null, error);
    };
  });
}

export async function watch(
  path: string,
  callback: WatchCallback,
  _options?: WatchOptions
): Promise<() => void> {
  // Ensure WebSocket is connected
  await ensureWebSocket();

  // Register the watcher
  if (!watchers.has(path)) {
    watchers.set(path, new Set());
  }
  watchers.get(path)!.add(callback);

  // Return unwatch function
  return () => {
    const callbacks = watchers.get(path);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        watchers.delete(path);
      }
    }

    // Close WebSocket if no more watchers
    if (watchers.size === 0 && ws) {
      ws.close();
      ws = null;
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    }
  };
}
