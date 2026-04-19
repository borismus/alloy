import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';
import type { QueuedMessage } from '../types';

interface MessageQueueContextValue {
  getQueue: (id: string) => QueuedMessage[];
  enqueue: (id: string, msg: QueuedMessage) => void;
  dequeue: (id: string) => QueuedMessage | null;
  remove: (id: string, messageId: string) => void;
}

const MessageQueueContext = createContext<MessageQueueContextValue | null>(null);

export function MessageQueueProvider({ children }: { children: React.ReactNode }) {
  const [queues, setQueues] = useState<Map<string, QueuedMessage[]>>(() => new Map());
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  const getQueue = useCallback((id: string): QueuedMessage[] => {
    return queuesRef.current.get(id) ?? [];
  }, []);

  const enqueue = useCallback((id: string, msg: QueuedMessage) => {
    setQueues(prev => {
      const next = new Map(prev);
      next.set(id, [...(next.get(id) ?? []), msg]);
      return next;
    });
  }, []);

  const dequeue = useCallback((id: string): QueuedMessage | null => {
    const current = queuesRef.current.get(id);
    if (!current || current.length === 0) return null;
    const [first] = current;
    setQueues(prev => {
      const q = prev.get(id);
      if (!q || q.length === 0) return prev;
      const rest = q.slice(1);
      const next = new Map(prev);
      if (rest.length === 0) next.delete(id);
      else next.set(id, rest);
      return next;
    });
    return first;
  }, []);

  const remove = useCallback((id: string, messageId: string) => {
    const current = queuesRef.current.get(id);
    if (!current) return;
    const target = current.find(m => m.id === messageId);
    if (target) {
      target.pendingImages.forEach(img => URL.revokeObjectURL(img.preview));
    }
    setQueues(prev => {
      const q = prev.get(id);
      if (!q) return prev;
      const filtered = q.filter(m => m.id !== messageId);
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(id);
      else next.set(id, filtered);
      return next;
    });
  }, []);

  const value = useMemo<MessageQueueContextValue>(
    () => ({ getQueue, enqueue, dequeue, remove }),
    [getQueue, enqueue, dequeue, remove, queues]
  );

  return <MessageQueueContext.Provider value={value}>{children}</MessageQueueContext.Provider>;
}

export function useMessageQueueContext(): MessageQueueContextValue {
  const context = useContext(MessageQueueContext);
  if (!context) {
    throw new Error('useMessageQueueContext must be used within a MessageQueueProvider');
  }
  return context;
}
