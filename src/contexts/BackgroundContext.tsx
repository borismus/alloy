import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { Conversation, Message, ToolUse } from '../types';
import { getBackgroundConversationId } from '../services/background';
import { vaultService } from '../services/vault';
import { skillRegistry } from '../services/skills';
import { executeViaServer } from '../services/server-streaming';
import { generateMessageId } from '../utils/ids';

/**
 * Background mode runs as a simple server-streamed chat: a single agent with
 * full server-side tool access, persisting to the daily
 * `_background-YYYY-MM-DD.yaml` conversation file. Streaming, tool execution,
 * and persistence all go through the same `/api/stream/*` path that regular
 * chat uses (see services/server-streaming.ts).
 *
 * The original orchestrator + parallel-task feature (task cards, per-task
 * cancellation) is intentionally out of scope; its UI scaffolding (`tasks`,
 * `cancelTask`) stays dormant.
 */

export interface BackgroundTask {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  content: string;
  toolUses: ToolUse[];
  error?: string;
  startedAt: string;
  completedAt?: string;
}

interface BackgroundContextValue {
  conversation: Conversation | null;
  tasks: BackgroundTask[];
  isOrchestratorBusy: boolean;
  queueLength: number;
  hasRunningTasks: boolean;
  sendMessage: (content: string) => void;
  clearHistory: () => void;
  setConversation: (conv: Conversation | null) => void;
  cancelTask: (taskId: string) => void;
  cancelAllTasks: () => void;
}

const BackgroundContext = createContext<BackgroundContextValue | null>(null);

interface BackgroundProviderProps {
  children: React.ReactNode;
  initialConversation: Conversation | null;
  defaultModel: string;
  memoryContent?: string;
  markSelfWrite: (path: string) => void;
}

export function BackgroundProvider({
  children,
  initialConversation,
  defaultModel,
  memoryContent,
  markSelfWrite,
}: BackgroundProviderProps) {
  const [conversation, setConversation] = useState<Conversation | null>(initialConversation);
  const [tasks] = useState<BackgroundTask[]>([]);
  // `busy` drives the stop button (hasRunningTasks); `waiting` drives the
  // thinking spinner shown only until the first chunk arrives.
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const defaultModelRef = useRef(defaultModel);
  defaultModelRef.current = defaultModel;
  const memoryContentRef = useRef(memoryContent);
  memoryContentRef.current = memoryContent;
  const markSelfWriteRef = useRef(markSelfWrite);
  markSelfWriteRef.current = markSelfWrite;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (initialConversation) {
      setConversation(initialConversation);
    }
  }, [initialConversation]);

  const saveConversation = useCallback(async (conv: Conversation) => {
    try {
      const vaultPath = vaultService.getVaultPath();
      if (vaultPath) {
        const filename = vaultService.generateFilename(conv.id);
        const filePath = `${vaultPath}/conversations/${filename}`;
        markSelfWriteRef.current(filePath);
      }
      await vaultService.saveConversation(conv);
    } catch (e) {
      console.error('[Background] Error saving conversation:', e);
    }
  }, []);

  const sendMessage = useCallback((content: string) => {
    // No message queue in this scope — ignore sends while a turn is in flight.
    if (busyRef.current) return;

    (async () => {
      const assistantMessageId = generateMessageId();
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        timestamp: new Date().toISOString(),
        content,
      };

      // Build the conversation with the user message (creating today's
      // background conversation if needed) and persist it so the file exists
      // before the server appends the assistant reply.
      const base: Conversation = conversationRef.current ?? {
        id: getBackgroundConversationId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        model: defaultModelRef.current,
        messages: [],
      };
      const isFirstMessage = base.messages.filter(m => m.role !== 'log').length === 0;
      const withUser: Conversation = {
        ...base,
        messages: [...base.messages, userMessage].slice(-500),
        updated: new Date().toISOString(),
      };
      setConversation(withUser);
      await saveConversation(withUser);

      // Live assistant message updates (streaming content / tool pills).
      const liveToolUses: ToolUse[] = [];
      const renderAssistant = (text: string, extra?: Partial<Message>) => {
        setConversation(prev => {
          if (!prev) return prev;
          const msgs = prev.messages.slice();
          const idx = msgs.findIndex(m => m.id === assistantMessageId);
          const assistantMsg: Message = {
            id: assistantMessageId,
            role: 'assistant',
            timestamp: new Date().toISOString(),
            content: text,
            model: defaultModelRef.current,
            toolUse: liveToolUses.length > 0 ? [...liveToolUses] : undefined,
            ...extra,
          };
          if (idx >= 0) msgs[idx] = assistantMsg;
          else msgs.push(assistantMsg);
          return { ...prev, messages: msgs, updated: new Date().toISOString() };
        });
      };

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setWaiting(true);
      let accumulated = '';

      try {
        const systemPrompt = skillRegistry.buildSystemPrompt(
          { id: withUser.id, title: withUser.title },
          memoryContentRef.current,
        );

        const result = await executeViaServer(
          withUser.id,
          assistantMessageId,
          withUser.model,
          withUser.messages,
          systemPrompt,
          isFirstMessage,
          content,
          {
            onChunk: (chunk) => {
              accumulated += chunk;
              setWaiting(false);
              renderAssistant(accumulated);
            },
            onToolUse: (toolUse) => {
              liveToolUses.push(toolUse);
              setWaiting(false);
              renderAssistant(accumulated);
            },
            signal: controller.signal,
          },
        );

        // Server persisted the assistant message; mirror the final result
        // (content + usage + tool uses) into local state.
        renderAssistant(result.content, {
          usage: result.usage,
          toolUse: result.toolUse ?? (liveToolUses.length > 0 ? [...liveToolUses] : undefined),
        });
      } catch (error: any) {
        if (error?.name === 'AbortError' || controller.signal.aborted) {
          // Keep whatever streamed in before the user stopped.
          if (accumulated.trim()) renderAssistant(accumulated);
        } else {
          console.error('[Background] stream failed:', error);
          renderAssistant(`Error: ${error?.message || 'Failed to get a response. Please check your configuration and try again.'}`);
        }
      } finally {
        setBusy(false);
        setWaiting(false);
        abortRef.current = null;
        // Persist final state (covers the abort/error paths the server didn't write).
        const finalConv = conversationRef.current;
        if (finalConv) await saveConversation(finalConv);
      }
    })().catch((e) => console.error('[Background] send failed:', e));
  }, [saveConversation]);

  const clearHistory = useCallback(async () => {
    const cleared: Conversation = {
      id: getBackgroundConversationId(),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      model: defaultModelRef.current,
      messages: [],
    };
    setConversation(cleared);
    await saveConversation(cleared);
  }, [saveConversation]);

  const cancelAllTasks = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const noop = useCallback(() => {}, []);

  const value: BackgroundContextValue = {
    conversation,
    tasks,
    isOrchestratorBusy: waiting,
    queueLength: 0,
    hasRunningTasks: busy,
    sendMessage,
    clearHistory,
    setConversation,
    cancelTask: noop,
    cancelAllTasks,
  };

  return (
    <BackgroundContext.Provider value={value}>
      {children}
    </BackgroundContext.Provider>
  );
}

export function useBackgroundContext(): BackgroundContextValue {
  const context = useContext(BackgroundContext);
  if (!context) {
    throw new Error('useBackgroundContext must be used within a BackgroundProvider');
  }
  return context;
}
