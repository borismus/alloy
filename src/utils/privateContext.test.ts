import { describe, it, expect } from 'vitest';
import { modelIsLocal, providerOf, shouldWarnBeforeModelSwitch } from './privateContext';
import type { ModelInfo } from '../types';

const models: ModelInfo[] = [
  { key: 'mlx/Qwen3', name: 'Qwen3', provider: 'mlx', local: true },
  { key: 'openrouter/anthropic/claude', name: 'Claude', provider: 'openrouter' },
  { key: 'codex-cli/gpt-5.6', name: 'GPT', provider: 'codex-cli' },
];

const conv = (model: string, isPrivate?: boolean) => ({ model, private: isPrivate });

describe('shouldWarnBeforeModelSwitch', () => {
  it('warns when a conversation holding private material moves to a cloud model', () => {
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3', true), 'openrouter/anthropic/claude', models)).toBe(true);
    // A CLI adapter runs locally but sends prompts onward, so it is cloud here.
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3', true), 'codex-cli/gpt-5.6', models)).toBe(true);
  });

  it('stays quiet when there is nothing private to disclose', () => {
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3'), 'openrouter/anthropic/claude', models)).toBe(false);
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3', false), 'openrouter/anthropic/claude', models)).toBe(false);
    expect(shouldWarnBeforeModelSwitch(null, 'openrouter/anthropic/claude', models)).toBe(false);
  });

  it('stays quiet when the destination keeps the material local', () => {
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3', true), 'mlx/Qwen3', models)).toBe(false);
  });

  it('warns again when a different company would receive it', () => {
    // The material left the machine already, but OpenAI receiving what
    // OpenRouter received is a new disclosure.
    expect(shouldWarnBeforeModelSwitch(conv('openrouter/anthropic/claude', true), 'codex-cli/gpt-5.6', models)).toBe(true);
  });

  it('stays quiet when swapping models within one provider', () => {
    const sameProvider: ModelInfo[] = [
      ...models,
      { key: 'openrouter/openai/gpt', name: 'GPT', provider: 'openrouter' },
    ];
    expect(
      shouldWarnBeforeModelSwitch(conv('openrouter/anthropic/claude', true), 'openrouter/openai/gpt', sameProvider),
    ).toBe(false);
  });

  it('stays quiet moving from cloud back to local', () => {
    expect(shouldWarnBeforeModelSwitch(conv('openrouter/anthropic/claude', true), 'mlx/Qwen3', models)).toBe(false);
  });

  it('still warns when discovery has not classified the models', () => {
    // Regression: keying on the origin being *known* local meant a failed model
    // discovery silently suppressed the warning — a miss in the one direction
    // that costs something.
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3', true), 'mystery/model', models)).toBe(true);
    expect(shouldWarnBeforeModelSwitch(conv('mystery/model', true), 'openrouter/anthropic/claude', models)).toBe(true);
    expect(shouldWarnBeforeModelSwitch(conv('mystery/model', true), 'mlx/Qwen3', models)).toBe(false);
  });
});

describe('modelIsLocal', () => {
  it('requires an explicit local flag', () => {
    expect(modelIsLocal(models, 'mlx/Qwen3')).toBe(true);
    expect(modelIsLocal(models, 'openrouter/anthropic/claude')).toBe(false);
    expect(modelIsLocal(models, 'absent/model')).toBe(false);
  });
});

describe('providerOf', () => {
  it('names the provider that would receive the conversation', () => {
    expect(providerOf(models, 'openrouter/anthropic/claude')).toBe('openrouter');
    expect(providerOf(models, 'codex-cli/gpt-5.6')).toBe('codex-cli');
    expect(providerOf(models, 'unlisted/some-model')).toBe('unlisted');
  });
});
