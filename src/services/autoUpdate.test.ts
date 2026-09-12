import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_UPDATE_CHANGED, getAutoUpdate, setAutoUpdate } from './autoUpdate';

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

  it('announces a change so the updater need not wait out its interval', () => {
    // Enabling the setting looked inert for a full cycle without this.
    const seen: boolean[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail.enabled);
    window.addEventListener(AUTO_UPDATE_CHANGED, listener);
    setAutoUpdate(true);
    setAutoUpdate(false);
    window.removeEventListener(AUTO_UPDATE_CHANGED, listener);
    expect(seen).toEqual([true, false]);
  });

  it('still persists when the change cannot be announced', () => {
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
      throw new Error('no listeners');
    });
    expect(() => setAutoUpdate(true)).not.toThrow();
    vi.restoreAllMocks();
    expect(getAutoUpdate()).toBe(true);
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
