import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../types';
import { chooseDefaultModel, providerLabel, providerTag } from './models';

const models: ModelInfo[] = [
  { key: 'provider/default', name: 'Configured default', provider: 'openai' },
  { key: 'provider/favorite-a', name: 'Favorite A', provider: 'openai' },
  { key: 'provider/favorite-b', name: 'Favorite B', provider: 'openai' },
];

afterEach(() => vi.restoreAllMocks());

describe('provider labels', () => {
  it('labels user-defined oMLX endpoints as oMLX so provenance search finds them', () => {
    expect(providerLabel('mlx', 'mlx/qwen')).toBe('oMLX');
    expect(providerLabel('mlx-local', 'mlx-local/qwen')).toBe('oMLX (mlx-local)');
    expect(providerTag('mlx-local', 'mlx-local/qwen')).toBe('MLX');
    // Non-MLX custom ids keep the prettified fallback.
    expect(providerLabel('acme', 'acme/foo')).toBe('Acme');
  });
});

describe('chooseDefaultModel', () => {
  it('uses the configured default before discovery even when favorites exist', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(chooseDefaultModel('provider/default', ['provider/favorite-a'], []))
      .toBe('provider/default');
  });

  it('uses the available configured default instead of a random favorite', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(chooseDefaultModel(
      'provider/default',
      ['provider/favorite-a', 'provider/favorite-b'],
      models,
    )).toBe('provider/default');
  });

  it('falls back deterministically when the configured default is unavailable', () => {
    expect(chooseDefaultModel(
      'provider/offline',
      ['provider/favorite-b', 'provider/favorite-a'],
      models,
    )).toBe('provider/favorite-b');
    expect(chooseDefaultModel('provider/offline', [], models)).toBe('provider/default');
  });

  it('uses the first configured favorite when neither catalog nor default exists', () => {
    expect(chooseDefaultModel('', ['provider/favorite-a', 'provider/favorite-b'], []))
      .toBe('provider/favorite-a');
  });
});
