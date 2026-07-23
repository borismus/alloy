import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateMessageId } from './ids';

describe('generateMessageId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns msg- followed by 4 hex chars', () => {
    // 0.9 has a long, repeating base-16 fraction, so slice(2, 6) yields a full
    // 4-char group — letting us assert the exact documented pattern.
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(generateMessageId()).toMatch(/^msg-[0-9a-f]{4}$/);
  });

  it('always starts with "msg-" and uses only hex chars', () => {
    // Real Math.random can occasionally produce a short fraction (e.g. 0.5 ->
    // "0.8"), so the group is 1–4 hex chars in the wild; the prefix and charset
    // are the invariant.
    for (let i = 0; i < 1000; i++) {
      expect(generateMessageId()).toMatch(/^msg-[0-9a-f]{1,4}$/);
    }
  });

  it('produces varied ids across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateMessageId()));
    expect(ids.size).toBeGreaterThan(1);
  });
});
