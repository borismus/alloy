import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Conversation, TriggerAttempt } from '../types';
import { triggerScheduler } from '../services/triggers/scheduler';
import { triggerExecutor } from '../services/triggers/executor';

interface FiredTrigger {
  conversationId: string;
  conversationTitle?: string;
  firedAt: string;
  reasoning: string;
}

interface TriggerContextValue {
  isSchedulerRunning: boolean;
  activeChecks: string[];
  firedTriggers: FiredTrigger[]; // Triggers that fired and need attention
  startScheduler: () => void;
  stopScheduler: () => void;
  dismissFiredTrigger: (conversationId: string) => void;
  clearAllFiredTriggers: () => void;
}

const TriggerContext = createContext<TriggerContextValue | null>(null);

interface TriggerProviderProps {
  children: React.ReactNode;
  getConversations: () => Conversation[];
  onConversationUpdated: (conversation: Conversation) => void;
  vaultPath: string | null;
}

export function TriggerProvider({
  children,
  getConversations,
  onConversationUpdated,
  vaultPath,
}: TriggerProviderProps) {
  const [isSchedulerRunning, setIsSchedulerRunning] = useState(false);
  const [activeChecks, setActiveChecks] = useState<string[]>([]);
  const [firedTriggers, setFiredTriggers] = useState<FiredTrigger[]>([]);

  // Use ref to always have latest conversations
  const getConversationsRef = useRef(getConversations);
  getConversationsRef.current = getConversations;

  const onConversationUpdatedRef = useRef(onConversationUpdated);
  onConversationUpdatedRef.current = onConversationUpdated;

  const MAX_HISTORY_ENTRIES = 50;

  // Helper to get fresh conversation data to avoid race conditions
  const getFreshConversation = (conversationId: string): Conversation | undefined => {
    return getConversationsRef.current().find(c => c.id === conversationId);
  };

  const addHistoryEntry = (trigger: Conversation['trigger'], attempt: TriggerAttempt): TriggerAttempt[] => {
    const existing = trigger?.history || [];
    return [attempt, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  };

  const startScheduler = useCallback(() => {
    if (isSchedulerRunning) return;

    triggerScheduler.start({
      getConversations: () => getConversationsRef.current(),

      onTriggerFired: async (conversation, result) => {
        // Re-fetch fresh conversation to avoid race conditions
        const freshConversation = getFreshConversation(conversation.id);
        if (!freshConversation?.trigger) return;

        const trigger = freshConversation.trigger;
        const now = new Date().toISOString();

        // Create history entry for this trigger firing
        const historyEntry: TriggerAttempt = {
          timestamp: now,
          result: 'triggered',
          reasoning: result.reasoning,
        };

        try {
          const { triggerPromptMsg, triggerReasoningMsg, mainPromptMsg, mainResponseMsg } =
            await triggerExecutor.executeMainPrompt(
              freshConversation,
              trigger,
              result.reasoning
            );

          // Re-fetch again after async operation to get latest state
          const latestConversation = getFreshConversation(conversation.id);
          if (!latestConversation?.trigger) return;

          // Update conversation with new messages, timestamps, and history
          // 4-message block: trigger prompt, trigger reasoning, main prompt, main response
          const updatedConversation: Conversation = {
            ...latestConversation,
            updated: now,
            messages: [
              ...latestConversation.messages,
              triggerPromptMsg,
              triggerReasoningMsg,
              mainPromptMsg,
              mainResponseMsg,
            ],
            trigger: {
              ...latestConversation.trigger,
              lastChecked: now,
              lastTriggered: now,
              history: addHistoryEntry(latestConversation.trigger, historyEntry),
            },
          };

          await onConversationUpdatedRef.current(updatedConversation);

          // Add to fired triggers list for UI notification
          setFiredTriggers((prev) => [
            {
              conversationId: conversation.id,
              conversationTitle: conversation.title,
              firedAt: new Date().toISOString(),
              reasoning: result.reasoning,
            },
            ...prev,
          ]);
        } catch (error) {
          console.error('Failed to execute main prompt:', error);
        }
      },

      onTriggerSkipped: async (conversation, result) => {
        // Re-fetch fresh conversation to avoid race conditions
        const freshConversation = getFreshConversation(conversation.id);
        if (!freshConversation?.trigger) return;

        const trigger = freshConversation.trigger;
        const now = new Date().toISOString();

        const historyEntry: TriggerAttempt = {
          timestamp: now,
          result: 'skipped',
          reasoning: result.reasoning,
        };

        const updatedConversation: Conversation = {
          ...freshConversation,
          // Preserve the original updated timestamp so skipped triggers don't bump the conversation
          updated: freshConversation.updated,
          trigger: {
            ...trigger,
            lastChecked: now,
            history: addHistoryEntry(trigger, historyEntry),
          },
        };
        await onConversationUpdatedRef.current(updatedConversation);
      },

      onTriggerChecking: (conversationId) => {
        setActiveChecks((prev) => [...prev, conversationId]);
      },

      onTriggerCheckComplete: (conversationId) => {
        setActiveChecks((prev) => prev.filter((id) => id !== conversationId));
      },

      onError: async (conversation, error) => {
        console.error('Trigger check error:', error);

        // Re-fetch fresh conversation to avoid race conditions
        const freshConversation = getFreshConversation(conversation.id);
        if (!freshConversation?.trigger) return;

        const trigger = freshConversation.trigger;
        const now = new Date().toISOString();

        const historyEntry: TriggerAttempt = {
          timestamp: now,
          result: 'error',
          reasoning: '',
          error: error.message,
        };

        const updatedConversation: Conversation = {
          ...freshConversation,
          updated: freshConversation.updated,
          trigger: {
            ...trigger,
            lastChecked: now,
            history: addHistoryEntry(trigger, historyEntry),
          },
        };
        await onConversationUpdatedRef.current(updatedConversation);
      },
    });

    setIsSchedulerRunning(true);
  }, [isSchedulerRunning]);

  const stopScheduler = useCallback(() => {
    triggerScheduler.stop();
    setIsSchedulerRunning(false);
    setActiveChecks([]);
  }, []);

  const dismissFiredTrigger = useCallback((conversationId: string) => {
    setFiredTriggers((prev) =>
      prev.filter((t) => t.conversationId !== conversationId)
    );
  }, []);

  const clearAllFiredTriggers = useCallback(() => {
    setFiredTriggers([]);
  }, []);

  // Auto-start scheduler when vault is available
  useEffect(() => {
    if (vaultPath && !isSchedulerRunning) {
      startScheduler();
    }
    return () => {
      if (isSchedulerRunning) {
        stopScheduler();
      }
    };
  }, [vaultPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: TriggerContextValue = {
    isSchedulerRunning,
    activeChecks,
    firedTriggers,
    startScheduler,
    stopScheduler,
    dismissFiredTrigger,
    clearAllFiredTriggers,
  };

  return (
    <TriggerContext.Provider value={value}>{children}</TriggerContext.Provider>
  );
}

export function useTriggerContext(): TriggerContextValue {
  const context = useContext(TriggerContext);
  if (!context) {
    throw new Error('useTriggerContext must be used within a TriggerProvider');
  }
  return context;
}
