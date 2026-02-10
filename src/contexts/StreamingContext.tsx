import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';
import type { ConversationStreamingState, SubagentStreamingState, ToolUse } from '../types';

interface StreamingContextValue {
  getStreamingState: (id: string) => ConversationStreamingState | null;
  getStreamingConversationIds: () => string[];
  getUnreadConversationIds: () => string[];
  startStreaming: (id: string) => AbortController;
  updateStreamingContent: (id: string, chunk: string) => void;
  addToolUse: (id: string, toolUse: ToolUse) => void;
  stopStreaming: (id: string) => void;
  completeStreaming: (id: string, isCurrentConversation?: boolean) => void;
  clearStreamingContent: (id: string) => void;
  markAsRead: (id: string) => void;
  // Sub-agent streaming
  startSubagents: (id: string, agents: { id: string; name: string; model: string; prompt: string }[]) => void;
  updateSubagentContent: (id: string, agentId: string, chunk: string) => void;
  addSubagentToolUse: (id: string, agentId: string, toolUse: ToolUse) => void;
  completeSubagent: (id: string, agentId: string, error?: string) => void;
  clearSubagents: (id: string) => void;
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

  const addToolUse = useCallback((id: string, toolUse: ToolUse) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;

      const next = new Map(prev);
      next.set(id, {
        ...existing,
        streamingToolUse: [...(existing.streamingToolUse || []), toolUse],
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

    // Mark as not streaming but keep content visible until clearStreamingContent is called
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(id, { ...existing, isStreaming: false });
      return next;
    });
  }, []);

  const clearStreamingContent = useCallback((id: string) => {
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

  // --- Sub-agent streaming methods ---

  const startSubagents = useCallback((id: string, agents: { id: string; name: string; model: string; prompt: string }[]) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;

      const subagentMap = new Map<string, SubagentStreamingState>();
      for (const agent of agents) {
        subagentMap.set(agent.id, {
          name: agent.name,
          model: agent.model,
          prompt: agent.prompt,
          content: '',
          status: 'pending',
        });
      }

      const next = new Map(prev);
      next.set(id, {
        ...existing,
        activeSubagents: subagentMap,
        preSubagentContent: existing.streamingContent,
        streamingContent: '',
      });
      return next;
    });
  }, []);

  const updateSubagentContent = useCallback((id: string, agentId: string, chunk: string) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing?.activeSubagents) return prev;

      const agent = existing.activeSubagents.get(agentId);
      if (!agent) return prev;

      const newSubagents = new Map(existing.activeSubagents);
      newSubagents.set(agentId, {
        ...agent,
        content: agent.content + chunk,
        status: 'streaming',
      });

      const next = new Map(prev);
      next.set(id, { ...existing, activeSubagents: newSubagents });
      return next;
    });
  }, []);

  const addSubagentToolUse = useCallback((id: string, agentId: string, toolUse: ToolUse) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing?.activeSubagents) return prev;

      const agent = existing.activeSubagents.get(agentId);
      if (!agent) return prev;

      const newSubagents = new Map(existing.activeSubagents);
      newSubagents.set(agentId, {
        ...agent,
        toolUse: [...(agent.toolUse || []), toolUse],
      });

      const next = new Map(prev);
      next.set(id, { ...existing, activeSubagents: newSubagents });
      return next;
    });
  }, []);

  const completeSubagent = useCallback((id: string, agentId: string, error?: string) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing?.activeSubagents) return prev;

      const agent = existing.activeSubagents.get(agentId);
      if (!agent) return prev;

      const newSubagents = new Map(existing.activeSubagents);
      newSubagents.set(agentId, {
        ...agent,
        status: error ? 'error' : 'complete',
        error,
      });

      const next = new Map(prev);
      next.set(id, { ...existing, activeSubagents: newSubagents });
      return next;
    });
  }, []);

  const clearSubagents = useCallback((id: string) => {
    setStreamingStates((prev) => {
      const existing = prev.get(id);
      if (!existing?.activeSubagents) return prev;

      const next = new Map(prev);
      const { activeSubagents: _, ...rest } = existing;
      next.set(id, rest);
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
      addToolUse,
      stopStreaming,
      completeStreaming,
      clearStreamingContent,
      markAsRead,
      startSubagents,
      updateSubagentContent,
      addSubagentToolUse,
      completeSubagent,
      clearSubagents,
    }),
    [
      getStreamingState,
      getStreamingConversationIds,
      getUnreadConversationIds,
      startStreaming,
      updateStreamingContent,
      addToolUse,
      stopStreaming,
      completeStreaming,
      clearStreamingContent,
      markAsRead,
      startSubagents,
      updateSubagentContent,
      addSubagentToolUse,
      completeSubagent,
      clearSubagents,
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
