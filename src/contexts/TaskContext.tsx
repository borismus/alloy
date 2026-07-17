import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ScheduledTask } from '../types';

interface DeliveredTaskResult {
  taskId: string;
  taskTitle?: string;
  deliveredAt: string;
  preview: string;
}

interface TaskContextValue {
  /** Task ids currently executing via Run Now. Server-scheduled executions are
   * observed through vault updates rather than this request-local state. */
  activeRuns: string[];
  deliveredResults: DeliveredTaskResult[];
  markRunning: (taskId: string) => void;
  markDone: (taskId: string) => void;
  dismissDeliveredResult: (taskId: string) => void;
}

const TaskContext = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children, tasks }: {
  children: React.ReactNode;
  tasks: ScheduledTask[];
}) {
  const [activeRuns, setActiveRuns] = useState<string[]>([]);
  const [deliveredResults, setDeliveredResults] = useState<DeliveredTaskResult[]>([]);
  const previousDeliveryRef = useRef<Map<string, string | undefined>>(new Map());

  useEffect(() => {
    const previous = previousDeliveryRef.current;
    const next = new Map<string, string | undefined>();
    const deliveries: DeliveredTaskResult[] = [];

    for (const task of tasks) {
      next.set(task.id, task.lastDeliveredAt);
      const previousTimestamp = previous.get(task.id);
      // Loading the vault should not replay historical deliveries as unread.
      if (previous.size === 0) continue;
      if (task.lastDeliveredAt && task.lastDeliveredAt !== previousTimestamp) {
        const latest = task.messages?.filter(message => message.role === 'assistant').slice(-1)[0];
        deliveries.push({
          taskId: task.id,
          taskTitle: task.title,
          deliveredAt: task.lastDeliveredAt,
          preview: (latest?.content || '').slice(0, 200),
        });
      }
    }

    previousDeliveryRef.current = next;
    if (deliveries.length > 0) {
      setDeliveredResults(current => [...deliveries, ...current]);
    }
  }, [tasks]);

  const markRunning = useCallback((id: string) => {
    setActiveRuns(current => current.includes(id) ? current : [...current, id]);
  }, []);

  const markDone = useCallback((id: string) => {
    setActiveRuns(current => current.filter(value => value !== id));
  }, []);

  const dismissDeliveredResult = useCallback((id: string) => {
    setDeliveredResults(current => current.filter(result => result.taskId !== id));
  }, []);

  return (
    <TaskContext.Provider value={{
      activeRuns,
      deliveredResults,
      markRunning,
      markDone,
      dismissDeliveredResult,
    }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTaskContext(): TaskContextValue {
  const context = useContext(TaskContext);
  if (!context) throw new Error('useTaskContext must be used within a TaskProvider');
  return context;
}
