import cronstrue from 'cronstrue';
import { CronExpressionParser } from 'cron-parser';
import { ScheduledTask } from '../types';

export interface SchedulePresentation {
  description: string;
  raw: string;
  timezone: string;
  nextRun?: string;
  invalid?: boolean;
}

export function describeTaskSchedule(task: ScheduledTask, now = new Date()): SchedulePresentation {
  const { cron, timezone } = task.schedule;
  try {
    const description = cronstrue.toString(cron, {
      throwExceptionOnParseError: true,
      use24HourTimeFormat: false,
    });
    const next = CronExpressionParser.parse(cron, {
      currentDate: now,
      tz: timezone,
    }).next().toDate();
    return {
      description,
      raw: cron,
      timezone,
      nextRun: formatNext(next, timezone),
    };
  } catch {
    return {
      description: 'Invalid schedule',
      raw: cron,
      timezone,
      invalid: true,
    };
  }
}

function formatNext(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
