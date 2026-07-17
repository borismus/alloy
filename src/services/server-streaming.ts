/**
 * Client-side adapter for server-buffered streaming.
 *
 * In server mode, delegates AI streaming to the server via SSE.
 * The server owns the stream and buffers all chunks, so the client
 * can disconnect (tab backgrounded) and reconnect without losing data.
 */

import type { Message, ToolUse } from '../types';

// API configuration. Inside Tauri the embedded server's URL is injected at
// boot by `src/services/tauri-bootstrap.ts`; in standalone browser mode we
// fall back to VITE_API_URL or same-origin.
export const getApiBase = (): string => {
  if (typeof window !== 'undefined' && (window as { __ALLOY_API_BASE__?: string }).__ALLOY_API_BASE__) {
    return (window as { __ALLOY_API_BASE__?: string }).__ALLOY_API_BASE__!;
  }
  return import.meta.env.VITE_API_URL || '';
};
const getAuthToken = () => import.meta.env.VITE_AUTH_TOKEN || '';

export function getAuthHeadersForApi(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

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
  usage?: { inputTokens: number; outputTokens: number; cost?: number; responseId?: string; durationMs?: number };
  stopReason?: string;
  title?: string; // Generated title for first messages
  toolUse?: ToolUse[]; // Tool uses observed during this turn (M4+ server-side tools)
}

export interface ServerStreamOptions {
  onChunk?: (text: string) => void;
  onTitle?: (title: string) => void;
  onToolUse?: (toolUse: ToolUse) => void;
  signal?: AbortSignal;
  /**
   * When true, the server runs the model + tool loop but does NOT append
   * the assistant message to any conversation YAML. Used by programmatic
   * callers (triggers) whose results live elsewhere.
   */
  skipPersist?: boolean;
  /**
   * Name of a vault skill the user explicitly invoked for this turn via a
   * `/skill_name` slash command. The backend appends its instructions to the
   * system prompt; unknown skills are ignored.
   */
  invokeSkill?: string;
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

  // Convert messages to server format (strip fields the server doesn't need).
  // Image attachments are passed as lightweight references (path + mimeType);
  // the server reads the bytes from the vault and base64-encodes them, so the
  // start payload stays small.
  const serverMessages = messages
    .filter(m => m.role !== 'log')
    .map(m => {
      const imageAttachments = m.attachments?.filter(a => a.type === 'image') ?? [];
      return {
        // `id` lets the server anchor a server-inserted compacted message at the
        // right boundary in the vault array (see alloy-server/src/compaction.rs).
        ...(m.id ? { id: m.id } : {}),
        role: m.role,
        content: m.content,
        ...(imageAttachments.length > 0
          ? { attachments: imageAttachments.map(a => ({ path: a.path, mimeType: a.mimeType })) }
          : {}),
      };
    });

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
      invokeSkill: options.invokeSkill,
      skipPersist: options.skipPersist ?? false,
    }),
  });

  if (!startResponse.ok) {
    const error = await startResponse.json().catch(() => ({ error: 'Failed to start stream' }));
    throw new Error(error.error || `Server returned ${startResponse.status}`);
  }

  // Subscribe to SSE events
  return new Promise<ServerStreamResult>((resolve, reject) => {
    let displayedLength = 0; // How much content we've already sent to onChunk
    let serverTitle: string | undefined;
    let eventSource: EventSource | null = null;
    let settled = false;

    // Track tool uses by tool_use_id so a later `tool_result` SSE event can
    // mutate the matching ToolUse entry's `result`/`isError` fields in
    // place — matches the in-place mutation pattern the client-side
    // executeWithTools uses.
    const toolUsesById = new Map<string, ToolUse>();
    const allToolUses: ToolUse[] = [];

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
        serverTitle = data.title;
        options.onTitle?.(data.title);
      });

      // Server-side tool execution events (M4+). The pill rendering in
      // ToolUseIndicator already knows how to handle ToolUse objects with
      // type/input/result/isError — we just need to keep that array fresh.
      eventSource.addEventListener('tool_use', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        const toolUse: ToolUse = {
          // The claude-cli provider calls Alloy's tools over MCP, which names
          // them `mcp__alloy__<tool>`. Strip the prefix so pills (and persisted
          // history) match the same labels/icons as every other provider.
          type: typeof data.name === 'string' ? data.name.replace(/^mcp__alloy__/, '') : data.name,
          input: data.input,
        };
        if (data.id) toolUsesById.set(data.id, toolUse);
        allToolUses.push(toolUse);
        options.onToolUse?.(toolUse);
      });

      eventSource.addEventListener('tool_result', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        const entry = toolUsesById.get(data.tool_use_id);
        if (entry) {
          // Truncate to match client-side executor display behavior.
          entry.result = typeof data.content === 'string'
            ? data.content.slice(0, 500)
            : '';
          if (data.is_error) entry.isError = true;
        }
      });

      eventSource.addEventListener('complete', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        settle(() => resolve({
          content: data.content,
          usage: data.usage,
          stopReason: data.stopReason,
          title: serverTitle,
          toolUse: allToolUses.length > 0 ? allToolUses : undefined,
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

/**
 * Convenience wrapper for "send a model call and get back the text" — no
 * conversation persistence, no UI streaming required from the caller.
 * Used by riff (drafts) and triggers. Internally still uses the streaming
 * endpoint so the server runs its tool loop and prompt-caching machinery.
 */
export async function executeChatOnce(
  model: string,
  messages: Message[],
  systemPrompt: string | undefined,
  options: { onChunk?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<{ content: string; usage?: ServerStreamResult['usage'] }> {
  const synthId = `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await executeViaServer(
    synthId,
    `msg-${Date.now()}`,
    model,
    messages,
    systemPrompt,
    false,
    messages[messages.length - 1]?.content ?? '',
    {
      onChunk: options.onChunk,
      signal: options.signal,
      skipPersist: true,
    },
  );
  return { content: result.content, usage: result.usage };
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
