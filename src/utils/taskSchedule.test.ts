import { describe, expect, it } from 'vitest';
import { ScheduledTask } from '../types';
import { describeTaskSchedule, parseTaskCron } from './taskSchedule';

function task(schedule: ScheduledTask['schedule']): ScheduledTask {
  return {
    id: 'task',
    created: '2026-07-20T00:00:00Z',
    updated: '2026-07-20T00:00:00Z',
    title: 'Task',
    model: 'mlx/test',
    enabled: true,
    prompt: 'Do it',
    schedule,
    messages: [],
  };
}

describe('describeTaskSchedule', () => {
  it('humanizes cron and calculates the next run in its timezone', () => {
    const result = describeTaskSchedule(
      task({ cron: '0 8 * * 1', timezone: 'America/Los_Angeles' }),
      new Date('2026-07-20T16:00:00Z'), // Monday 9 AM PDT
    );
    expect(result.description).toBe('At 08:00 AM, only on Monday');
    expect(result.raw).toBe('0 8 * * 1');
    expect(result.timezone).toBe('America/Los_Angeles');
    expect(result.nextRun).toContain('Mon, Jul 27');
    expect(result.nextRun).toContain('8:00 AM');
  });

  it('surfaces invalid schedules instead of throwing', () => {
    const result = describeTaskSchedule(task({ cron: 'bad cron', timezone: 'UTC' }));
    expect(result.invalid).toBe(true);
    expect(result.description).toBe('Invalid schedule');
    expect(result.raw).toBe('bad cron');
  });

  it('rejects six-field cron even though cron-parser accepts it', () => {
    expect(() => parseTaskCron('0 30 6 * * *', 'UTC')).toThrow('exactly five fields');
    expect(describeTaskSchedule(task({ cron: '0 30 6 * * *', timezone: 'UTC' })).invalid).toBe(true);
  });

});
