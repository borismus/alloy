import { describe, it, expect } from 'vitest';
import { modelIsLocal, modelSwitchDisclosure, providerOf, shouldWarnBeforeModelSwitch } from './privateContext';
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

  it('warns leaving a local model even with no tool reads at all', () => {
    // The case that made me change this rule: a conversation typed entirely into
    // a local model, no tools used. Choosing a local model is the privacy
    // decision; switching sends everything the user typed under that assumption.
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3'), 'openrouter/anthropic/claude', models)).toBe(true);
    expect(modelSwitchDisclosure(conv('mlx/Qwen3'), 'codex-cli/gpt-5.6', models)).toBe('local-origin');
  });

  it('stays quiet when nothing leaves the machine', () => {
    expect(shouldWarnBeforeModelSwitch(null, 'openrouter/anthropic/claude', models)).toBe(false);
    // Cloud to cloud, same provider, nothing private recorded.
    expect(shouldWarnBeforeModelSwitch(conv('openrouter/anthropic/claude'), 'openrouter/openai/gpt', [
      ...models,
      { key: 'openrouter/openai/gpt', name: 'GPT', provider: 'openrouter' },
    ])).toBe(false);
  });

  it('stays quiet when the destination keeps the material local', () => {
    expect(shouldWarnBeforeModelSwitch(conv('mlx/Qwen3', true), 'mlx/Qwen3', models)).toBe(false);
  });

  it('warns again when a different company would receive it', () => {
    // The material left the machine already, but OpenAI receiving what
    // OpenRouter received is a new disclosure.
    expect(modelSwitchDisclosure(conv('openrouter/anthropic/claude', true), 'codex-cli/gpt-5.6', models))
      .toBe('private-material');
    // ...but an ordinary cloud conversation moving between providers does not,
    // or the warning would fire on nearly every switch and stop being read.
    expect(shouldWarnBeforeModelSwitch(conv('openrouter/anthropic/claude'), 'codex-cli/gpt-5.6', models)).toBe(false);
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

  it('still warns when discovery has not classified the destination', () => {
    // An unknown destination counts as cloud: discovery can fail, and the safe
    // reading of "unknown" is the one that warns.
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

describe('an origin the catalog cannot classify', () => {
  it('warns rather than assuming the conversation was already in the cloud', () => {
    // Discovery fails whenever a local endpoint is asleep or unauthorized —
    // observed live: a bad oMLX key returned zero local models, the origin could
    // not be recognized as local, and the warning silently disarmed.
    expect(modelSwitchDisclosure(conv('mlx-local/Qwen3'), 'openrouter/anthropic/claude', models))
      .toBe('unknown-origin');
    // Still silent when the destination keeps it on the machine.
    expect(modelSwitchDisclosure(conv('mlx-local/Qwen3'), 'mlx/Qwen3', models)).toBe(null);
  });

  it('does not fire for a known cloud origin', () => {
    expect(modelSwitchDisclosure(conv('openrouter/anthropic/claude'), 'openrouter/openai/gpt', [
      ...models,
      { key: 'openrouter/openai/gpt', name: 'GPT', provider: 'openrouter' },
    ])).toBe(null);
  });
});
