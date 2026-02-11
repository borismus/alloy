/**
 * HTTP-based implementation of @tauri-apps/plugin-fs
 *
 * Calls the Wheelhouse server API for filesystem operations.
 * Used in SERVER_MODE when running as a web app against a remote server.
 */

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

// API configuration
const getApiBase = () => import.meta.env.VITE_API_URL || '';
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

function ensureWebSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve(ws);
      return;
    }

    if (wsConnecting) {
      // Wait for existing connection attempt
      const checkInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          clearInterval(checkInterval);
          resolve(ws);
        }
      }, 100);
      return;
    }

    wsConnecting = true;

    const apiBase = getApiBase();
    const wsUrl = apiBase.replace(/^http/, 'ws') + '/api/watch';
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[WS] Connected to file watcher');
      ws = socket;
      wsConnecting = false;
      resolve(socket);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WatchEvent;

        // Dispatch to matching watchers
        watchers.forEach((callbacks, watchPath) => {
          const matches = data.paths.some(p =>
            p === watchPath || p.startsWith(watchPath + '/') || watchPath.startsWith(p)
          );
          if (matches) {
            callbacks.forEach(cb => {
              try {
                cb(data);
              } catch (err) {
                console.error('[WS] Watcher callback error:', err);
              }
            });
          }
        });
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    socket.onclose = () => {
      console.log('[WS] Disconnected from file watcher');
      ws = null;
      wsConnecting = false;

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
      reject(new Error('WebSocket connection failed'));
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
