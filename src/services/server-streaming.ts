/**
 * Client-side adapter for server-buffered streaming.
 *
 * In server mode, delegates AI streaming to the server via SSE.
 * The server owns the stream and buffers all chunks, so the client
 * can disconnect (tab backgrounded) and reconnect without losing data.
 */

import type { Message } from '../types';

const getApiBase = () => import.meta.env.VITE_API_URL || '';
const getAuthToken = () => import.meta.env.VITE_AUTH_TOKEN || '';

function generateSessionId(): string {
  return `ss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export interface ServerStreamResult {
  content: string;
  usage?: { inputTokens: number; outputTokens: number; cost?: number; responseId?: string };
  stopReason?: string;
  title?: string; // Generated title for first messages
}

export interface ServerStreamOptions {
  onChunk?: (text: string) => void;
  onTitle?: (title: string) => void;
  signal?: AbortSignal;
}

/**
 * Execute a conversation turn via the server's streaming API.
 *
 * - POSTs to /api/stream/start to kick off the server-side stream
 * - Connects to /api/stream/events/:id via EventSource for live chunks
 * - Handles reconnection on visibility change (tab foregrounded)
 * - Returns when the stream is complete
 */
export async function executeViaServer(
  conversationId: string,
  assistantMessageId: string,
  model: string,
  messages: Message[],
  systemPrompt: string | undefined,
  isFirstMessage: boolean,
  userMessageContent: string,
  options: ServerStreamOptions = {},
): Promise<ServerStreamResult> {
  const sessionId = generateSessionId();
  const apiBase = getApiBase();

  // Convert messages to server format (strip fields the server doesn't need)
  const serverMessages = messages
    .filter(m => m.role !== 'log')
    .map(m => ({
      role: m.role,
      content: m.content,
    }));

  // Start the streaming session
  const startResponse = await fetch(`${apiBase}/api/stream/start`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sessionId,
      conversationId,
      assistantMessageId,
      model,
      messages: serverMessages,
      systemPrompt,
      isFirstMessage,
      userMessageContent,
    }),
  });

  if (!startResponse.ok) {
    const error = await startResponse.json().catch(() => ({ error: 'Failed to start stream' }));
    throw new Error(error.error || `Server returned ${startResponse.status}`);
  }

  // Subscribe to SSE events
  return new Promise<ServerStreamResult>((resolve, reject) => {
    let displayedLength = 0; // How much content we've already sent to onChunk
    let result: ServerStreamResult | null = null;
    let eventSource: EventSource | null = null;
    let settled = false;

    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    }

    function cleanup() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      options.signal?.removeEventListener('abort', onAbort);
    }

    function connect() {
      const url = new URL(`${apiBase}/api/stream/events/${sessionId}`, window.location.origin);
      const token = getAuthToken();
      if (token) url.searchParams.set('token', token);

      eventSource = new EventSource(url.toString());

      eventSource.addEventListener('replay', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        const content = data.content as string;
        // Only emit the delta we haven't shown yet
        if (content.length > displayedLength) {
          const delta = content.slice(displayedLength);
          displayedLength = content.length;
          options.onChunk?.(delta);
        }
      });

      eventSource.addEventListener('chunk', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        const text = data.text as string;
        displayedLength += text.length;
        options.onChunk?.(text);
      });

      eventSource.addEventListener('title', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        options.onTitle?.(data.title);
      });

      eventSource.addEventListener('complete', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        settle(() => resolve({
          content: data.content,
          usage: data.usage,
          stopReason: data.stopReason,
          title: result?.title,
        }));
      });

      eventSource.addEventListener('error', (e: MessageEvent | Event) => {
        // SSE error event — could be a connection drop or a server error
        if ('data' in e && e.data) {
          const data = JSON.parse((e as MessageEvent).data);
          settle(() => reject(new Error(data.message || 'Stream error')));
        }
        // Connection error — EventSource will auto-reconnect, but on mobile
        // it might not. We handle reconnection via visibilitychange.
      });

      // Also handle the generic onerror for connection failures
      eventSource.onerror = () => {
        // EventSource auto-reconnects; if it's permanently closed
        // we rely on visibilitychange to reconnect
        if (eventSource?.readyState === EventSource.CLOSED && !settled) {
          // Connection permanently closed — will reconnect on visibility change
        }
      };
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && !settled) {
        // Tab foregrounded — check if EventSource is dead
        if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
          connect();
        }
      }
    }

    function onAbort() {
      // Tell the server to stop
      fetch(`${apiBase}/api/stream/stop/${sessionId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      }).catch(() => {}); // Best effort

      settle(() => reject(new DOMException('Aborted', 'AbortError')));
    }

    // Set up handlers
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Start the SSE connection
    connect();
  });
}

// --- Reconnection on page reload ---

interface ActiveSession {
  sessionId: string;
  conversationId: string;
  status: string;
}

export interface ReconnectCallbacks {
  startStreaming: (conversationId: string) => AbortController;
  updateStreamingContent: (conversationId: string, chunk: string) => void;
  completeStreaming: (conversationId: string) => void;
  stopStreaming: (conversationId: string) => void;
}

/**
 * Check for active server streaming sessions and reconnect to them.
 * Called after page load to resume displaying in-flight streams.
 */
export async function reconnectToActiveSessions(callbacks: ReconnectCallbacks): Promise<void> {
  const apiBase = getApiBase();

  let activeSessions: ActiveSession[];
  try {
    const response = await fetch(`${apiBase}/api/stream/active`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) return;
    activeSessions = await response.json();
  } catch {
    return; // Server not reachable
  }

  for (const session of activeSessions) {
    if (session.status !== 'streaming' && session.status !== 'complete') continue;

    const convId = session.conversationId;
    const controller = callbacks.startStreaming(convId);

    // Subscribe to SSE for this session
    const url = new URL(`${apiBase}/api/stream/events/${session.sessionId}`, window.location.origin);
    const token = getAuthToken();
    if (token) url.searchParams.set('token', token);

    const eventSource = new EventSource(url.toString());

    eventSource.addEventListener('replay', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      callbacks.updateStreamingContent(convId, data.content);
    });

    eventSource.addEventListener('chunk', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      callbacks.updateStreamingContent(convId, data.text);
    });

    eventSource.addEventListener('complete', () => {
      eventSource.close();
      callbacks.completeStreaming(convId);
    });

    eventSource.addEventListener('error', (e: Event) => {
      if ('data' in e && (e as MessageEvent).data) {
        eventSource.close();
        callbacks.stopStreaming(convId);
      }
    });

    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        callbacks.completeStreaming(convId);
      }
    };

    // Wire abort to close the EventSource
    controller.signal.addEventListener('abort', () => {
      eventSource.close();
      fetch(`${apiBase}/api/stream/stop/${session.sessionId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      }).catch(() => {});
    }, { once: true });
  }
}
