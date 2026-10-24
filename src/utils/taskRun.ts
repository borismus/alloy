import type { ScheduledTask } from '../types';

/**
 * A `running` marker whose heartbeat is older than this belongs to a run whose
 * server died before recording an outcome. Mirrors `HEARTBEAT_STALE_AFTER` in
 * alloy-server/src/tasks/scheduler.rs.
 */
export const HEARTBEAT_STALE_AFTER_MS = 5 * 60 * 1000;

/** Whether a run of `task` is in progress on any device, per its vault marker. */
export function isTaskRunning(task: ScheduledTask, now: number = Date.now()): boolean {
  const heartbeat = task.running ? Date.parse(task.running.heartbeatAt) : NaN;
  return Number.isFinite(heartbeat) && now - heartbeat <= HEARTBEAT_STALE_AFTER_MS;
}
