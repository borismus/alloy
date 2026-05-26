import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Trigger } from '../types';

interface FiredTrigger {
  conversationId: string;
  conversationTitle?: string;
  firedAt: string;
  reasoning: string;
}

interface TriggerContextValue {
  /** Trigger ids currently being executed via Run Now. The background
   *  scheduler also fires triggers, but that happens in alloy-server and
   *  isn't surfaced here — the UI only spins for in-flight POST /run calls. */
  activeChecks: string[];
  firedTriggers: FiredTrigger[];
  markRunning: (triggerId: string) => void;
  markDone: (triggerId: string) => void;
  dismissFiredTrigger: (conversationId: string) => void;
}

const TriggerContext = createContext<TriggerContextValue | null>(null);

interface TriggerProviderProps {
  children: React.ReactNode;
  triggers: Trigger[];
}

export function TriggerProvider({ children, triggers }: TriggerProviderProps) {
  const [activeChecks, setActiveChecks] = useState<string[]>([]);
  const [firedTriggers, setFiredTriggers] = useState<FiredTrigger[]>([]);

  // Detect "this trigger just fired" by comparing the previous lastTriggered
  // to the current one. The server writes the YAML, the file watcher feeds
  // App.tsx, which re-renders us with new props — that's how we notice.
  const prevLastTriggeredRef = useRef<Map<string, string | undefined>>(new Map());

  useEffect(() => {
    const prev = prevLastTriggeredRef.current;
    const next = new Map<string, string | undefined>();
    const fires: FiredTrigger[] = [];

    for (const t of triggers) {
      next.set(t.id, t.lastTriggered);
      const prevTs = prev.get(t.id);
      // Skip on the very first render (prev is empty) so loading the vault
      // doesn't show notifications for every historical fire.
      if (prev.size === 0) continue;
      if (t.lastTriggered && t.lastTriggered !== prevTs) {
        const last = t.messages?.filter(m => m.role === 'assistant').slice(-1)[0];
        fires.push({
          conversationId: t.id,
          conversationTitle: t.title,
          firedAt: t.lastTriggered,
          reasoning: (last?.content || '').slice(0, 200),
        });
      }
    }

    prevLastTriggeredRef.current = next;
    if (fires.length > 0) {
      setFiredTriggers(curr => [...fires, ...curr]);
    }
  }, [triggers]);

  const markRunning = useCallback((id: string) => {
    setActiveChecks(curr => (curr.includes(id) ? curr : [...curr, id]));
  }, []);

  const markDone = useCallback((id: string) => {
    setActiveChecks(curr => curr.filter(x => x !== id));
  }, []);

  const dismissFiredTrigger = useCallback((conversationId: string) => {
    setFiredTriggers(curr => curr.filter(t => t.conversationId !== conversationId));
  }, []);

  return (
    <TriggerContext.Provider
      value={{ activeChecks, firedTriggers, markRunning, markDone, dismissFiredTrigger }}
    >
      {children}
    </TriggerContext.Provider>
  );
}

export function useTriggerContext(): TriggerContextValue {
  const context = useContext(TriggerContext);
  if (!context) {
    throw new Error('useTriggerContext must be used within a TriggerProvider');
  }
  return context;
}
