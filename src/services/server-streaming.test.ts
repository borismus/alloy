import { describe, expect, it } from 'vitest';
import { formatSentAt } from './server-streaming';

describe('formatSentAt', () => {
  it('formats a timestamp with weekday, date, and time', () => {
    const formatted = formatSentAt('2026-09-19T03:16:19.517Z');
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\d:\d{2}/);
  });

  it('is stable for the same message, so earlier turns stay cacheable', () => {
    expect(formatSentAt('2026-09-19T03:16:19.517Z')).toBe(formatSentAt('2026-09-19T03:16:19.517Z'));
  });

  it('passes through an unparseable timestamp rather than printing "Invalid Date"', () => {
    expect(formatSentAt('not a date')).toBe('not a date');
  });
});
