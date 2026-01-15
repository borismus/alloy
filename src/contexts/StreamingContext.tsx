import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';
import type { ConversationStreamingState } from '../types';

interface StreamingContextValue {
  getStreamingState: (id: string) => ConversationStreamingState | null;
  getStreamingConversationIds: () => string[];
  getUnreadConversationIds: () => string[];
  startStreaming: (id: string) => AbortController;
  updateStreamingContent: (id: string, chunk: string) => void;
  stopStreaming: (id: string) => void;
  completeStreaming: (id: string, isCurrentConversation?: boolean) => void;
  markAsRead: (id: string) => void;
}

const StreamingContext = createContext<StreamingContextValue | null>(null);

export function StreamingProvider({ children }: { children: React.ReactNode }) {
  const [streamingStates, setStreamingStates] = useState<Map<string, ConversationStreamingState>>(
    () => new Map()
  );
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const getStreamingState = useCallback(
    (id: string): ConversationStreamingState | null => {
      return streamingStates.get(id) ?? null;
    },
    [streamingStates]
  );

  const getStreamingConversationIds = useCallback((): string[] => {
    return Array.from(streamingStates.entries())
      .filter(([, state]) => state.isStreaming)
      .map(([id]) => id);
  }, [streamingStates]);

  const getUnreadConversationIds = useCallback((): string[] => {
    return Array.from(unreadIds);
  }, [unreadIds]);

  const startStreaming = useCallback((id: string): AbortController => {
    // Abort any existing stream for this conversation
    const existingController = abortControllersRef.current.get(id);
    if (existingController) {
      existingController.abort();
    }

    const controller = new AbortController();
    abortControllersRef.current.set(id, controller);

    setStreamingStates((prev) => {
      const next = new Map(prev);
      next.set(id, { isStreaming: true, streamingContent: '' });
      return next;
    });

    return controller;
  }, []);

  const updateStreamingContent = useCallback((id: string, chunk: string) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;

      const next = new Map(prev);
      next.set(id, {
        ...existing,
        streamingContent: existing.streamingContent + chunk,
      });
      return next;
    });
  }, []);

  const stopStreaming = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }

    setStreamingStates((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const completeStreaming = useCallback((id: string, isCurrentConversation: boolean = true) => {
    abortControllersRef.current.delete(id);

    // If not viewing this conversation, mark it as unread
    if (!isCurrentConversation) {
      setUnreadIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }

    setStreamingStates((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const markAsRead = useCallback((id: string) => {
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<StreamingContextValue>(
    () => ({
      getStreamingState,
      getStreamingConversationIds,
      getUnreadConversationIds,
      startStreaming,
      updateStreamingContent,
      stopStreaming,
      completeStreaming,
      markAsRead,
    }),
    [
      getStreamingState,
      getStreamingConversationIds,
      getUnreadConversationIds,
      startStreaming,
      updateStreamingContent,
      stopStreaming,
      completeStreaming,
      markAsRead,
    ]
  );

  return <StreamingContext.Provider value={value}>{children}</StreamingContext.Provider>;
}

export function useStreamingContext(): StreamingContextValue {
  const context = useContext(StreamingContext);
  if (!context) {
    throw new Error('useStreamingContext must be used within a StreamingProvider');
  }
  return context;
}
