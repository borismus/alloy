import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSelectedItem, saveSelectedItem } from './selectionStorage';

const conversation = { type: 'conversation' as const, id: '2024-01-15-1000-aa01' };

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('selection persistence', () => {
  it('round-trips a selection', () => {
    saveSelectedItem(conversation);
    expect(loadSelectedItem()).toEqual(conversation);
  });

  it('survives a session ending, which is the whole point', () => {
    // sessionStorage is discarded when the tab session ends — exactly what iOS
    // does to a backgrounded tab, and what a desktop app restart looks like.
    // Anything written must outlive that.
    saveSelectedItem(conversation);
    sessionStorage.clear();
    expect(loadSelectedItem()).toEqual(conversation);
  });

  it('migrates a selection written by the old sessionStorage version', () => {
    sessionStorage.setItem('selectedItem', JSON.stringify(conversation));
    expect(loadSelectedItem()).toEqual(conversation);
  });

  it('drops the legacy copy once something is saved, so they cannot diverge', () => {
    sessionStorage.setItem('selectedItem', JSON.stringify(conversation));
    saveSelectedItem({ type: 'note', id: 'other.md' });
    expect(sessionStorage.getItem('selectedItem')).toBeNull();
    expect(loadSelectedItem()).toEqual({ type: 'note', id: 'other.md' });
  });

  it('clears on an empty selection', () => {
    saveSelectedItem(conversation);
    saveSelectedItem(null);
    expect(loadSelectedItem()).toBeNull();
  });

  it('ignores a corrupt or stale value instead of failing to start', () => {
    localStorage.setItem('alloy.selectedItem', '{not json');
    expect(loadSelectedItem()).toBeNull();

    localStorage.setItem('alloy.selectedItem', JSON.stringify({ nope: true }));
    expect(loadSelectedItem()).toBeNull();
  });

  it('tolerates storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => saveSelectedItem(conversation)).not.toThrow();
  });
});
