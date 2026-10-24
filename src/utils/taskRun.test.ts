import { describe, expect, it } from 'vitest';
import type { ScheduledTask } from '../types';
import { HEARTBEAT_STALE_AFTER_MS, isTaskRunning } from './taskRun';

const NOW = Date.parse('2026-10-24T17:00:00Z');

function task(heartbeatAt?: string): ScheduledTask {
  return {
    id: 't',
    created: '2026-10-01T00:00:00Z',
    updated: '2026-10-01T00:00:00Z',
    title: 'Task',
    model: 'mlx/q',
    enabled: true,
    prompt: 'p',
    schedule: { cron: '0 8 * * *', timezone: 'UTC' },
    running: heartbeatAt ? { host: 'smusmini', startedAt: heartbeatAt, heartbeatAt } : undefined,
    messages: [],
  };
}

describe('isTaskRunning', () => {
  it('is running while the heartbeat is fresh', () => {
    expect(isTaskRunning(task(new Date(NOW - 60 * 1000).toISOString()), NOW)).toBe(true);
    expect(isTaskRunning(task(new Date(NOW - HEARTBEAT_STALE_AFTER_MS).toISOString()), NOW)).toBe(true);
  });

  it('is not running once the heartbeat goes stale', () => {
    expect(isTaskRunning(task(new Date(NOW - HEARTBEAT_STALE_AFTER_MS - 1).toISOString()), NOW)).toBe(false);
  });

  it('is not running without a readable marker', () => {
    expect(isTaskRunning(task(), NOW)).toBe(false);
    expect(isTaskRunning(task('not a date'), NOW)).toBe(false);
  });
});
