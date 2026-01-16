import { useCallback } from 'react';
import { useStreamingContext } from '../contexts/StreamingContext';
import { ToolUse } from '../types';

export function useConversationStreaming(conversationId: string | null) {
  const ctx = useStreamingContext();

  const streamingState = conversationId ? ctx.getStreamingState(conversationId) : null;

  const isStreaming = streamingState?.isStreaming ?? false;
  const streamingContent = streamingState?.streamingContent ?? '';
  const streamingToolUse = streamingState?.streamingToolUse ?? [];
  const error = streamingState?.error ?? null;

  const start = useCallback(() => {
    if (!conversationId) return null;
    return ctx.startStreaming(conversationId);
  }, [conversationId, ctx]);

  const stop = useCallback(() => {
    if (!conversationId) return;
    ctx.stopStreaming(conversationId);
  }, [conversationId, ctx]);

  const updateContent = useCallback(
    (chunk: string) => {
      if (!conversationId) return;
      ctx.updateStreamingContent(conversationId, chunk);
    },
    [conversationId, ctx]
  );

  const complete = useCallback((isCurrentConversation: boolean = true) => {
    if (!conversationId) return;
    ctx.completeStreaming(conversationId, isCurrentConversation);
  }, [conversationId, ctx]);

  const clear = useCallback(() => {
    if (!conversationId) return;
    ctx.clearStreamingContent(conversationId);
  }, [conversationId, ctx]);

  const addToolUse = useCallback(
    (toolUse: ToolUse) => {
      if (!conversationId) return;
      ctx.addToolUse(conversationId, toolUse);
    },
    [conversationId, ctx]
  );

  return {
    isStreaming,
    streamingContent,
    streamingToolUse,
    error,
    start,
    stop,
    updateContent,
    addToolUse,
    complete,
    clear,
  };
}
