import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import { executeViaServer, formatSentAt } from './server-streaming';

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

describe('history sent with a turn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never includes what an earlier turn's tools read", async () => {
    // The local airlock: a private conversation runs on a local model, which
    // reads private notes with its tools, and is then switched to a cloud model.
    // The cloud model must receive only the visible conversation. Raw tool
    // results, sub-agent transcripts and reasoning stay in the vault file.
    const secret = 'JOURNAL-LINE-only-the-local-model-may-read';
    const messages: Message[] = [
      { id: 'u1', role: 'user', timestamp: '2026-10-01T10:00:00Z', content: 'What did I write about the trip?' },
      {
        id: 'a1',
        role: 'assistant',
        timestamp: '2026-10-01T10:00:05Z',
        content: 'You wrote that the trip was restful.',
        model: 'mlx/qwen',
        partialReasoning: `The journal says ${secret}`,
        toolUse: [{ type: 'read_file', input: { path: 'private/journal/trip.md' }, result: secret }],
        subagentResponses: [{
          name: 'Research',
          model: 'mlx/qwen',
          prompt: `Summarize ${secret}`,
          content: `Found ${secret}`,
          toolUse: [{ type: 'search_directory', result: secret }],
        }],
      },
      { id: 'u2', role: 'user', timestamp: '2026-10-01T10:01:00Z', content: 'Plan a similar trip.' },
    ];

    let body = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '');
      // Stop after the start request; the stream itself isn't under test.
      return { ok: false, status: 500, json: async () => ({ error: 'stop here' }) };
    }));

    await expect(executeViaServer(
      'conv-1', 'a2', 'codex-cli/gpt', messages, undefined, false, 'Plan a similar trip.',
    )).rejects.toThrow('stop here');

    const sent = JSON.parse(body).messages as Array<Record<string, unknown>>;
    expect(sent.map(m => m.content)).toEqual([
      'What did I write about the trip?',
      'You wrote that the trip was restful.',
      'Plan a similar trip.',
    ]);
    expect(body).not.toContain(secret);
  });
});
