import { describe, expect, it, vi } from 'vitest';
import {
  cycleModelPreference,
  persistModelPreferencesOptimistically,
  setDefaultPreference,
  toggleFavoritePreference,
  type ModelPreferences,
} from './modelPreferences';

const initial: ModelPreferences = {
  defaultModel: 'provider/default',
  favoriteModels: ['provider/default', 'provider/favorite'],
};

describe('model preferences', () => {
  it('toggles yellow favorites but never removes the active default', () => {
    expect(toggleFavoritePreference(initial, 'provider/new').favoriteModels)
      .toEqual(['provider/default', 'provider/favorite', 'provider/new']);
    expect(toggleFavoritePreference(initial, 'provider/favorite').favoriteModels)
      .toEqual(['provider/default']);
    expect(toggleFavoritePreference(initial, 'provider/default')).toBe(initial);
  });

  it('assigns one default and demotes the previous default to a favorite', () => {
    expect(setDefaultPreference(initial, 'provider/new')).toEqual({
      defaultModel: 'provider/new',
      favoriteModels: ['provider/default', 'provider/favorite', 'provider/new'],
    });
  });

  it('cycles hollow → favorite → default → hollow', () => {
    const hollow = cycleModelPreference(initial, 'provider/new');
    expect(hollow.favoriteModels).toContain('provider/new');
    expect(hollow.defaultModel).toBe('provider/default');

    const promoted = cycleModelPreference(hollow, 'provider/new');
    expect(promoted.defaultModel).toBe('provider/new');
    // The previous default demotes to a yellow favorite, never vanishing.
    expect(promoted.favoriteModels).toContain('provider/default');

    const cleared = cycleModelPreference(promoted, 'provider/new');
    expect(cleared.defaultModel).toBe('');
    expect(cleared.favoriteModels).not.toContain('provider/new');
    // Unrelated favorites survive the whole cycle.
    expect(cleared.favoriteModels).toContain('provider/favorite');
  });

  it('rolls optimistic state back when the config write fails', async () => {
    const next = setDefaultPreference(initial, 'provider/new');
    const apply = vi.fn();
    const error = new Error('write failed');

    await expect(persistModelPreferencesOptimistically(
      initial,
      next,
      apply,
      async () => { throw error; },
    )).rejects.toThrow('write failed');

    expect(apply.mock.calls).toEqual([[next], [initial]]);
  });
});
