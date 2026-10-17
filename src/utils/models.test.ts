import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../types';
import { chooseDefaultModel, isLocalModel, modelDisplayName, providerLabel, providerTag } from './models';

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

describe('isLocalModel', () => {
  const providers = [
    { id: 'claude-cli', local: false },
    { id: 'mlx', local: true },
  ];

  it('follows the configured provider even when the model was not discovered', () => {
    // The oMLX host is asleep: discovery found nothing, yet the model is local.
    expect(isLocalModel('mlx/Qwen3.8-27B-MLX-4bit', providers, [])).toBe(true);
    expect(isLocalModel('claude-cli/opus', providers, [])).toBe(false);
  });

  it('resolves an unprefixed or unknown model to the default provider', () => {
    expect(isLocalModel('opus', providers)).toBe(false);
    expect(isLocalModel('mlx', [{ id: 'mlx', local: true }])).toBe(true);
  });

  it('falls back to the discovered catalog only before providers load', () => {
    const catalog = [{ key: 'mlx/q', name: 'q', local: true }];
    expect(isLocalModel('mlx/q', [], catalog)).toBe(true);
    expect(isLocalModel('mlx/q', [{ id: 'mlx', local: false }], catalog)).toBe(false);
  });
});

describe('modelDisplayName', () => {
  const catalog: ModelInfo[] = [
    { key: 'claude-cli/sonnet', name: 'Claude Sonnet 5.5', provider: 'claude-cli' },
    { key: 'codex-cli/gpt-6.1-sol', name: 'GPT-6.1-Sol', provider: 'codex-cli' },
  ];

  it('uses the catalog name for a known model', () => {
    expect(modelDisplayName('claude-cli/sonnet', catalog)).toBe('Claude Sonnet 5.5');
  });

  it('resolves a model saved under another provider by its id', () => {
    // Older conversations kept the provider they were created with; the same
    // model must not show as "gpt-6.1-sol" on one row and "GPT-6.1-Sol" on the next.
    expect(modelDisplayName('openai/gpt-6.1-sol', catalog)).toBe('GPT-6.1-Sol');
  });

  it('falls back to the bare id for an unknown model', () => {
    expect(modelDisplayName('mlx/qwen', catalog)).toBe('qwen');
    expect(modelDisplayName('qwen', [])).toBe('qwen');
  });
});
