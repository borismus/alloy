import { describe, expect, it, vi } from 'vitest';
import {
  persistModelPreferencesOptimistically,
  setDefaultPreference,
  toggleFavoritePreference,
  type ModelPreferences,
} from './modelPreferences';

const initial: ModelPreferences = {
  defaultModel: 'provider/default',
  favoriteModels: ['provider/favorite'],
};

describe('model preferences', () => {
  it('toggles favorites directly but never changes the active default', () => {
    expect(toggleFavoritePreference(initial, 'provider/new')).toEqual({
      defaultModel: 'provider/default',
      favoriteModels: ['provider/favorite', 'provider/new'],
    });
    expect(toggleFavoritePreference(initial, 'provider/favorite')).toEqual({
      defaultModel: 'provider/default',
      favoriteModels: [],
    });
    expect(toggleFavoritePreference(initial, 'provider/default')).toBe(initial);
  });

  it('changes the default without changing independent favorite state', () => {
    expect(setDefaultPreference(initial, 'provider/new')).toEqual({
      defaultModel: 'provider/new',
      favoriteModels: ['provider/favorite'],
    });
  });

  it('preserves a favorite while it temporarily serves as the default', () => {
    const withFavorite = toggleFavoritePreference(initial, 'provider/new');
    const promoted = setDefaultPreference(withFavorite, 'provider/new');
    expect(promoted.favoriteModels).toContain('provider/new');

    const replaced = setDefaultPreference(promoted, 'provider/other');
    expect(replaced.favoriteModels).toContain('provider/new');
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
