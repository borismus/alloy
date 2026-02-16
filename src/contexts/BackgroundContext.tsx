import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { Conversation, Message, ToolUse } from '../types';
import { BUILTIN_TOOLS } from '../types/tools';
import {
  BACKGROUND_CONVERSATION_ID,
  DELEGATE_TOOL,
  getOrchestratorSystemPrompt,
  getTaskSystemPrompt,
  getOrchestratorModel,
  getProviderForModel,
} from '../services/background';
import { executeWithTools } from '../services/tools/executor';
import { vaultService } from '../services/vault';

const generateMessageId = () => `msg-${Math.random().toString(16).slice(2, 6)}`;
const generateTaskId = () => `task-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

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
  sendMessage: (content: string) => void;
  clearHistory: () => void;
  setConversation: (conv: Conversation | null) => void;
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
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [isOrchestratorBusy, setIsOrchestratorBusy] = useState(false);

  // Refs for stable access in async operations
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const defaultModelRef = useRef(defaultModel);
  defaultModelRef.current = defaultModel;
  const memoryContentRef = useRef(memoryContent);
  memoryContentRef.current = memoryContent;
  const markSelfWriteRef = useRef(markSelfWrite);
  markSelfWriteRef.current = markSelfWrite;

  // Sync when initial conversation changes (e.g., vault reload)
  useEffect(() => {
    if (initialConversation) {
      setConversation(initialConversation);
    }
  }, [initialConversation]);

  const sendMessage = useCallback((content: string) => {
    setMessageQueue(prev => [...prev, content]);
  }, []);

  const clearHistory = useCallback(async () => {
    const model = defaultModelRef.current;
    const cleared: Conversation = {
      id: BACKGROUND_CONVERSATION_ID,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      model,
      messages: [],
    };
    setConversation(cleared);
    setTasks([]);
    await saveConversation(cleared);
  }, []);

  /**
   * Save the background conversation to vault.
   */
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

  /**
   * Append a message to the conversation and save.
   */
  const appendMessage = useCallback(async (message: Message): Promise<Conversation> => {
    const current = conversationRef.current;
    if (!current) {
      // Create conversation if it doesn't exist
      const conv: Conversation = {
        id: BACKGROUND_CONVERSATION_ID,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        model: defaultModelRef.current,
        messages: [message],
      };
      setConversation(conv);
      await saveConversation(conv);
      return conv;
    }

    const updated: Conversation = {
      ...current,
      messages: [...current.messages, message],
      updated: new Date().toISOString(),
    };
    setConversation(updated);
    await saveConversation(updated);
    return updated;
  }, [saveConversation]);

  /**
   * Launch a background task (fire-and-forget).
   */
  const launchTask = useCallback((name: string, prompt: string) => {
    const taskId = generateTaskId();
    const task: BackgroundTask = {
      id: taskId,
      name,
      status: 'running',
      content: '',
      toolUses: [],
      startedAt: new Date().toISOString(),
    };

    setTasks(prev => [...prev, task]);

    // Fire and forget — run the task asynchronously
    (async () => {
      try {
        const modelKey = defaultModelRef.current;
        const resolved = getProviderForModel(modelKey);
        if (!resolved) {
          throw new Error(`No provider available for model ${modelKey}`);
        }

        const { provider, modelId } = resolved;

        // Task gets full tools except spawn_subagent (no nesting)
        const taskTools = BUILTIN_TOOLS.filter(t => t.name !== 'spawn_subagent');

        const taskMessages: Message[] = [{
          role: 'user' as const,
          timestamp: new Date().toISOString(),
          content: prompt,
        }];

        const systemPrompt = getTaskSystemPrompt(memoryContentRef.current);

        const result = await executeWithTools(provider, taskMessages, modelId, {
          maxIterations: 10,
          tools: taskTools,
          systemPrompt,
          toolContext: {
            messageId: generateMessageId(),
            conversationId: `conversations/${BACKGROUND_CONVERSATION_ID}`,
          },
          onChunk: (chunk) => {
            setTasks(prev => prev.map(t =>
              t.id === taskId ? { ...t, content: t.content + chunk } : t
            ));
          },
          onToolUse: (toolUse) => {
            setTasks(prev => prev.map(t =>
              t.id === taskId ? { ...t, toolUses: [...t.toolUses, toolUse] } : t
            ));
          },
        });

        // Mark task complete
        setTasks(prev => prev.map(t =>
          t.id === taskId
            ? { ...t, status: 'completed' as const, content: result.finalContent, completedAt: new Date().toISOString() }
            : t
        ));

        // Append result as an assistant message to the conversation
        const resultMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          timestamp: new Date().toISOString(),
          content: result.finalContent,
          model: modelKey,
          toolUse: result.allToolUses.length > 0 ? result.allToolUses : undefined,
          skillUse: result.skillUses.length > 0 ? result.skillUses : undefined,
        };
        await appendMessage(resultMessage);
      } catch (error: any) {
        const errorMsg = error?.message || 'Unknown error';
        console.error(`[Background] Task "${name}" failed:`, error);

        setTasks(prev => prev.map(t =>
          t.id === taskId
            ? { ...t, status: 'error' as const, error: errorMsg, completedAt: new Date().toISOString() }
            : t
        ));

        // Append error message to conversation
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          timestamp: new Date().toISOString(),
          content: `Task "${name}" failed: ${errorMsg}`,
          model: defaultModelRef.current,
        };
        await appendMessage(errorMessage);
      }
    })();
  }, [appendMessage]);

  /**
   * Process a single user message through the orchestrator.
   */
  const processMessage = useCallback(async (content: string) => {
    // 1. Append user message to conversation
    const userMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      timestamp: new Date().toISOString(),
      content,
    };
    await appendMessage(userMessage);

    // 2. Get orchestrator model and provider
    const orchestratorModelKey = getOrchestratorModel();
    if (!orchestratorModelKey) {
      const errorMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: 'No AI provider configured. Please add an API key in Settings.',
      };
      await appendMessage(errorMessage);
      return;
    }

    const resolved = getProviderForModel(orchestratorModelKey);
    if (!resolved) {
      const errorMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: 'AI provider not available. Please check your configuration.',
      };
      await appendMessage(errorMessage);
      return;
    }

    const { provider, modelId } = resolved;

    // 3. Build messages for orchestrator (include recent conversation for context)
    const currentConv = conversationRef.current;
    const recentMessages = currentConv
      ? currentConv.messages.slice(-10) // Last 10 messages for context
      : [userMessage];

    // Make sure the user message we just added is included
    const orchestratorMessages = recentMessages[recentMessages.length - 1]?.id === userMessage.id
      ? recentMessages
      : [...recentMessages, userMessage];

    // 4. Single API call to orchestrator
    try {
      const result = await provider.sendMessage(
        orchestratorMessages,
        {
          model: modelId,
          systemPrompt: getOrchestratorSystemPrompt(),
          tools: [DELEGATE_TOOL],
        },
      );

      // 5. Save orchestrator acknowledgment
      const ackContent = result.content || '';
      if (ackContent.trim()) {
        const ackMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          timestamp: new Date().toISOString(),
          content: ackContent,
          model: orchestratorModelKey,
        };
        await appendMessage(ackMessage);
      }

      // 6. Parse and dispatch any delegate tool calls
      if (result.stopReason === 'tool_use' && result.toolCalls) {
        for (const toolCall of result.toolCalls) {
          if (toolCall.name === 'delegate') {
            const name = (toolCall.input.name as string) || 'Task';
            const prompt = (toolCall.input.prompt as string) || content;
            launchTask(name, prompt);
          }
        }
      }
    } catch (error: any) {
      console.error('[Background] Orchestrator error:', error);
      const errorMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: `Error: ${error?.message || 'Failed to process message'}`,
      };
      await appendMessage(errorMessage);
    }
  }, [appendMessage, launchTask]);

  // Message queue processor
  useEffect(() => {
    if (isOrchestratorBusy || messageQueue.length === 0) return;

    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    setIsOrchestratorBusy(true);

    processMessage(next).finally(() => {
      setIsOrchestratorBusy(false);
    });
  }, [isOrchestratorBusy, messageQueue, processMessage]);

  const value: BackgroundContextValue = {
    conversation,
    tasks,
    isOrchestratorBusy,
    queueLength: messageQueue.length,
    sendMessage,
    clearHistory,
    setConversation,
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
