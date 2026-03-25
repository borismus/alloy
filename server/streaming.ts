/**
 * Server-side streaming session manager.
 *
 * Manages AI streaming sessions that survive client disconnects.
 * Each session buffers all chunks so clients can reconnect and replay.
 */

import type { Response } from 'express';
import { getProvider, type ServerMessage, type StreamResult } from './providers.js';
import { appendAssistantMessage, updateTitle } from './vault-writer.js';
import { estimateCostServer } from './pricing.js';

export interface StreamSession {
  id: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  isFirstMessage: boolean;
  userMessageContent: string; // For title generation
  status: 'streaming' | 'complete' | 'error';
  chunks: string[];           // Incremental text deltas
  fullContent: string;        // Accumulated text
  error?: string;
  result?: StreamResult;
  abortController: AbortController;
  subscribers: Set<Response>;  // Active SSE connections
  createdAt: number;
}

const sessions = new Map<string, StreamSession>();

// Clean up completed sessions after 5 minutes
const SESSION_TTL_MS = 5 * 60 * 1000;

function scheduleCleanup(sessionId: string) {
  setTimeout(() => {
    const session = sessions.get(sessionId);
    if (session && (session.status === 'complete' || session.status === 'error')) {
      sessions.delete(sessionId);
      console.log(`[Streaming] Cleaned up session ${sessionId}`);
    }
  }, SESSION_TTL_MS);
}

function sendSSE(res: Response, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Flush compression buffer — without this, SSE events get stuck
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  } catch {
    // Client disconnected
  }
}

function broadcastSSE(session: StreamSession, event: string, data: unknown) {
  for (const subscriber of session.subscribers) {
    sendSSE(subscriber, event, data);
  }
}

export interface StartSessionParams {
  sessionId: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  messages: ServerMessage[];
  systemPrompt?: string;
  isFirstMessage: boolean;
  userMessageContent: string;
  vaultPath: string;
}

/**
 * Start a new streaming session. The AI stream runs in the background;
 * clients subscribe via SSE to receive chunks.
 */
export function startSession(params: StartSessionParams): StreamSession {
  const {
    sessionId, conversationId, assistantMessageId, model,
    messages, systemPrompt, isFirstMessage, userMessageContent, vaultPath,
  } = params;

  // If a session with this ID already exists, return it (idempotent)
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const abortController = new AbortController();

  const session: StreamSession = {
    id: sessionId,
    conversationId,
    assistantMessageId,
    model,
    isFirstMessage,
    userMessageContent,
    status: 'streaming',
    chunks: [],
    fullContent: '',
    abortController,
    subscribers: new Set(),
    createdAt: Date.now(),
  };

  sessions.set(sessionId, session);

  // Start streaming in the background (don't await)
  runStream(session, messages, systemPrompt, vaultPath).catch(err => {
    console.error(`[Streaming] Unhandled error in session ${sessionId}:`, err);
  });

  return session;
}

async function runStream(
  session: StreamSession,
  messages: ServerMessage[],
  systemPrompt: string | undefined,
  vaultPath: string,
) {
  try {
    const [provider, modelId] = getProvider(session.model);

    const result = await provider.stream({
      messages,
      model: modelId,
      systemPrompt,
      signal: session.abortController.signal,
      onChunk: (text: string) => {
        session.chunks.push(text);
        session.fullContent += text;
        broadcastSSE(session, 'chunk', { text });
      },
    });

    session.result = result;
    session.status = 'complete';

    // Calculate cost
    let usage: { inputTokens: number; outputTokens: number; cost?: number; responseId?: string } | undefined;
    if (result.usage) {
      const cost = estimateCostServer(session.model, result.usage.inputTokens, result.usage.outputTokens);
      usage = {
        ...result.usage,
        ...(cost !== undefined && { cost }),
      };
    }

    // Write to vault
    await appendAssistantMessage(vaultPath, session.conversationId, session.assistantMessageId, result, usage);

    // Generate title for first message
    if (session.isFirstMessage) {
      try {
        const title = await provider.generateTitle(session.userMessageContent, result.content);
        if (title) {
          await updateTitle(vaultPath, session.conversationId, title);
          broadcastSSE(session, 'title', { title });
        }
      } catch (e) {
        console.error('[Streaming] Title generation failed (non-fatal):', e);
      }
    }

    broadcastSSE(session, 'complete', {
      content: result.content,
      usage,
      stopReason: result.stopReason,
    });

    console.log(`[Streaming] Session ${session.id} complete (${session.fullContent.length} chars)`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    session.status = 'error';
    session.error = message;

    // Save partial content if we have any
    if (session.fullContent.trim()) {
      await appendAssistantMessage(vaultPath, session.conversationId, session.assistantMessageId, {
        content: session.fullContent,
        stopReason: 'end_turn',
      });
    }

    broadcastSSE(session, 'error', { message });
    console.error(`[Streaming] Session ${session.id} error:`, message);
  } finally {
    scheduleCleanup(session.id);
  }
}

export function getSession(sessionId: string): StreamSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Return all sessions that are currently streaming (or recently completed).
 * Used by the client to reconnect after a page reload.
 */
export function getActiveSessions(): { sessionId: string; conversationId: string; status: string }[] {
  const result: { sessionId: string; conversationId: string; status: string }[] = [];
  for (const [id, session] of sessions) {
    // Include streaming and recently-completed sessions (not yet cleaned up)
    result.push({
      sessionId: id,
      conversationId: session.conversationId,
      status: session.status,
    });
  }
  return result;
}

export function stopSession(sessionId: string): StreamSession | undefined {
  const session = sessions.get(sessionId);
  if (session && session.status === 'streaming') {
    session.abortController.abort();
  }
  return session;
}

/**
 * Subscribe an SSE response to a session. Replays buffered content first.
 */
export function subscribe(session: StreamSession, res: Response) {
  // Send replay of all content so far
  if (session.fullContent) {
    sendSSE(res, 'replay', { content: session.fullContent });
  }

  // If already complete, send the final event and close
  if (session.status === 'complete' && session.result) {
    sendSSE(res, 'complete', {
      content: session.result.content,
      usage: session.result.usage,
      stopReason: session.result.stopReason,
    });
    return;
  }

  if (session.status === 'error') {
    sendSSE(res, 'error', { message: session.error || 'Unknown error' });
    return;
  }

  // Add as live subscriber
  session.subscribers.add(res);

  res.on('close', () => {
    session.subscribers.delete(res);
  });
}
