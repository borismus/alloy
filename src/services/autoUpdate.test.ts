import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAutoUpdate, setAutoUpdate } from './autoUpdate';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('auto-update preference', () => {
  it('is off unless explicitly enabled', () => {
    // Opt-in: an unattended relaunch should never be a surprise default.
    expect(getAutoUpdate()).toBe(false);
  });

  it('round-trips through localStorage', () => {
    setAutoUpdate(true);
    expect(getAutoUpdate()).toBe(true);
    setAutoUpdate(false);
    expect(getAutoUpdate()).toBe(false);
  });

  it('is per-machine, not stored in the synced vault config', () => {
    // The vault is synced between machines, so a vault-level flag would force
    // the same behavior everywhere — the opposite of the intent.
    setAutoUpdate(true);
    expect(localStorage.getItem('alloy.autoUpdate')).toBe('true');
  });

  it('treats unavailable localStorage as opt-out rather than throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(getAutoUpdate()).toBe(false);
  });

  it('does not throw when the preference cannot be persisted', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setAutoUpdate(true)).not.toThrow();
  });
});
