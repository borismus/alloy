import { useEffect, useMemo, useState } from 'react';
import type { ScheduledTask } from '../types';
import { isTaskRunning } from '../utils/taskRun';

const RECHECK_MS = 30 * 1000;

/**
 * Ids of the tasks running right now. A marker can go stale without its file
 * changing (the server died mid-run), so while any task carries one this
 * re-checks on a timer; with none, nothing ticks.
 */
export function useRunningTaskIds(tasks: ScheduledTask[]): Set<string> {
  const [now, setNow] = useState(() => Date.now());
  const anyMarked = tasks.some(task => task.running);

  useEffect(() => {
    if (!anyMarked) return;
    const timer = setInterval(() => setNow(Date.now()), RECHECK_MS);
    return () => clearInterval(timer);
  }, [anyMarked]);

  return useMemo(
    () => new Set(tasks.filter(task => isTaskRunning(task, now)).map(task => task.id)),
    [tasks, now],
  );
}
