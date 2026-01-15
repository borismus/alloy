import { useCallback } from 'react';
import { useStreamingContext } from '../contexts/StreamingContext';

export function useConversationStreaming(conversationId: string | null) {
  const ctx = useStreamingContext();

  const streamingState = conversationId ? ctx.getStreamingState(conversationId) : null;

  const isStreaming = streamingState?.isStreaming ?? false;
  const streamingContent = streamingState?.streamingContent ?? '';
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

  return {
    isStreaming,
    streamingContent,
    error,
    start,
    stop,
    updateContent,
    complete,
  };
}
