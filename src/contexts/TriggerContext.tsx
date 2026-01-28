import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Conversation, Message, TriggerAttempt, Trigger } from '../types';
import { triggerScheduler } from '../services/triggers/scheduler';

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
  getTriggers: () => Trigger[];
  onTriggerUpdated: (trigger: Trigger) => void;
  vaultPath: string | null;
}

export function TriggerProvider({
  children,
  getTriggers,
  onTriggerUpdated,
  vaultPath,
}: TriggerProviderProps) {
  const [isSchedulerRunning, setIsSchedulerRunning] = useState(false);
  const [activeChecks, setActiveChecks] = useState<string[]>([]);
  const [firedTriggers, setFiredTriggers] = useState<FiredTrigger[]>([]);

  // Use ref to always have latest triggers
  const getTriggersRef = useRef(getTriggers);
  getTriggersRef.current = getTriggers;

  const onTriggerUpdatedRef = useRef(onTriggerUpdated);
  onTriggerUpdatedRef.current = onTriggerUpdated;

  const MAX_HISTORY_ENTRIES = 50;

  // Helper to get fresh trigger data to avoid race conditions
  const getFreshTrigger = (triggerId: string): Trigger | undefined => {
    return getTriggersRef.current().find(t => t.id === triggerId);
  };

  const addHistoryEntry = (trigger: Conversation['trigger'], attempt: TriggerAttempt): TriggerAttempt[] => {
    const existing = trigger?.history || [];
    return [attempt, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  };

  const startScheduler = useCallback(() => {
    if (isSchedulerRunning) return;

    triggerScheduler.start({
      getConversations: () => getTriggersRef.current() as Conversation[],

      onTriggerFired: async (triggerDoc, result) => {
        // Re-fetch fresh trigger to avoid race conditions
        const freshTrigger = getFreshTrigger(triggerDoc.id);
        if (!freshTrigger?.trigger) return;

        const triggerConfig = freshTrigger.trigger;
        const now = new Date().toISOString();

        // Create history entry for this trigger firing
        const historyEntry: TriggerAttempt = {
          timestamp: now,
          result: 'triggered',
          reasoning: result.response.slice(0, 200), // Brief summary for history
        };

        // Create the 2-message block: trigger prompt + response
        const triggerPromptMsg: Message = {
          role: 'user',
          timestamp: now,
          content: triggerConfig.triggerPrompt,
        };

        const triggerResponseMsg: Message = {
          role: 'assistant',
          timestamp: now,
          content: result.response,
          model: triggerConfig.model,
        };

        // Update trigger with new messages, timestamps, and history
        const updatedTrigger: Trigger = {
          ...freshTrigger,
          updated: now,
          messages: [
            ...freshTrigger.messages,
            triggerPromptMsg,
            triggerResponseMsg,
          ],
          trigger: {
            ...triggerConfig,
            lastChecked: now,
            lastTriggered: now,
            history: addHistoryEntry(triggerConfig, historyEntry),
          },
        };

        await onTriggerUpdatedRef.current(updatedTrigger);

        // Add to fired triggers list for UI notification
        setFiredTriggers((prev) => [
          {
            conversationId: triggerDoc.id,
            conversationTitle: triggerDoc.title,
            firedAt: now,
            reasoning: result.response.slice(0, 200),
          },
          ...prev,
        ]);
      },

      onTriggerSkipped: async (triggerDoc, result) => {
        // Re-fetch fresh trigger to avoid race conditions
        const freshTrigger = getFreshTrigger(triggerDoc.id);
        if (!freshTrigger?.trigger) return;

        const triggerConfig = freshTrigger.trigger;
        const now = new Date().toISOString();

        const historyEntry: TriggerAttempt = {
          timestamp: now,
          result: 'skipped',
          reasoning: result.response,
        };

        const updatedTrigger: Trigger = {
          ...freshTrigger,
          // Preserve the original updated timestamp so skipped triggers don't bump the trigger
          updated: freshTrigger.updated,
          trigger: {
            ...triggerConfig,
            lastChecked: now,
            history: addHistoryEntry(triggerConfig, historyEntry),
          },
        };
        await onTriggerUpdatedRef.current(updatedTrigger);
      },

      onTriggerChecking: (triggerId) => {
        setActiveChecks((prev) => [...prev, triggerId]);
      },

      onTriggerCheckComplete: (triggerId) => {
        setActiveChecks((prev) => prev.filter((id) => id !== triggerId));
      },

      onError: async (triggerDoc, error) => {
        console.error('Trigger check error:', error);

        // Re-fetch fresh trigger to avoid race conditions
        const freshTrigger = getFreshTrigger(triggerDoc.id);
        if (!freshTrigger?.trigger) return;

        const triggerConfig = freshTrigger.trigger;
        const now = new Date().toISOString();

        const historyEntry: TriggerAttempt = {
          timestamp: now,
          result: 'error',
          reasoning: '',
          error: error.message,
        };

        const updatedTrigger: Trigger = {
          ...freshTrigger,
          updated: freshTrigger.updated,
          trigger: {
            ...triggerConfig,
            lastChecked: now,
            history: addHistoryEntry(triggerConfig, historyEntry),
          },
        };
        await onTriggerUpdatedRef.current(updatedTrigger);
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
