import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { Conversation, Message, ToolUse } from '../types';
import { getBackgroundConversationId } from '../services/background';
import { vaultService } from '../services/vault';
import { generateMessageId } from '../utils/ids';

/**
 * Phase 3 stub: the background orchestrator + parallel-task feature used
 * the deleted client-side providers/tools layer (see git history). The
 * surrounding context (state shape, conversation persistence, message
 * queueing) is preserved so the UI keeps rendering; sending a message
 * appends a notice instead of running a model.
 *
 * Re-enable by porting orchestrator + task execution to a server endpoint
 * (single-turn for orchestrator, multi-turn for tasks).
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

const OFFLINE_NOTICE =
  'Background mode is offline in this build. The orchestrator + parallel-task feature is being re-implemented on the server.';

export function BackgroundProvider({
  children,
  initialConversation,
  defaultModel,
  markSelfWrite,
}: BackgroundProviderProps) {
  const [conversation, setConversation] = useState<Conversation | null>(initialConversation);
  const [tasks] = useState<BackgroundTask[]>([]);

  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const defaultModelRef = useRef(defaultModel);
  defaultModelRef.current = defaultModel;
  const markSelfWriteRef = useRef(markSelfWrite);
  markSelfWriteRef.current = markSelfWrite;

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

  const appendMessage = useCallback(async (message: Message): Promise<void> => {
    const current = conversationRef.current;
    if (!current) {
      const conv: Conversation = {
        id: getBackgroundConversationId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        model: defaultModelRef.current,
        messages: [message],
      };
      setConversation(conv);
      await saveConversation(conv);
      return;
    }
    const updated: Conversation = {
      ...current,
      messages: [...current.messages, message].slice(-500),
      updated: new Date().toISOString(),
    };
    setConversation(updated);
    await saveConversation(updated);
  }, [saveConversation]);

  const sendMessage = useCallback((content: string) => {
    // Persist the user message + an offline notice, no model call.
    (async () => {
      await appendMessage({
        id: generateMessageId(),
        role: 'user',
        timestamp: new Date().toISOString(),
        content,
      });
      await appendMessage({
        id: generateMessageId(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: OFFLINE_NOTICE,
        model: defaultModelRef.current,
      });
    })().catch((e) => console.error('[Background] append failed:', e));
  }, [appendMessage]);

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

  const noop = useCallback(() => {}, []);

  const value: BackgroundContextValue = {
    conversation,
    tasks,
    isOrchestratorBusy: false,
    queueLength: 0,
    hasRunningTasks: false,
    sendMessage,
    clearHistory,
    setConversation,
    cancelTask: noop,
    cancelAllTasks: noop,
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
