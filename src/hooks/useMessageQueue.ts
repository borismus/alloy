import { useCallback } from 'react';
import { useMessageQueueContext } from '../contexts/MessageQueueContext';
import type { QueuedMessage } from '../types';

export function useMessageQueue(conversationId: string | null) {
  const ctx = useMessageQueueContext();

  const queue = conversationId ? ctx.getQueue(conversationId) : [];

  const enqueue = useCallback((msg: QueuedMessage) => {
    if (!conversationId) return;
    ctx.enqueue(conversationId, msg);
  }, [conversationId, ctx]);

  const dequeue = useCallback((): QueuedMessage | null => {
    if (!conversationId) return null;
    return ctx.dequeue(conversationId);
  }, [conversationId, ctx]);

  const removeQueued = useCallback((messageId: string) => {
    if (!conversationId) return;
    ctx.remove(conversationId, messageId);
  }, [conversationId, ctx]);

  return { queue, enqueue, dequeue, removeQueued };
}
