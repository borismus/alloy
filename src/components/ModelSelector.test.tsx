import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModelSelector } from './ModelSelector';
import type { ModelInfo } from '../types';

const models: ModelInfo[] = [
  { key: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic' },
  { key: 'openrouter/anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'openrouter' },
  { key: 'mlx/qwen3.6-27b', name: 'Qwen 3.6 27B', provider: 'mlx', local: true },
];

afterEach(cleanup);

describe('ModelSelector', () => {
  it('shows the selected model name on the trigger', () => {
    render(
      <ModelSelector
        value="anthropic/claude-opus-4-6"
        onChange={vi.fn()}
        disabled={false}
        models={models}
        favoriteModels={[]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Model: Claude Opus 4.6' })).toBeTruthy();
  });

  it('humanizes a stale model key not present in the catalog', () => {
    render(
      <ModelSelector
        value="gemini/gemini-3-1-pro-preview"
        onChange={vi.fn()}
        disabled={false}
        models={models}
        favoriteModels={[]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Model: Gemini 3 1 Pro Preview' })).toBeTruthy();
  });

  it('disables the trigger when disabled', () => {
    render(
      <ModelSelector
        value="anthropic/claude-opus-4-6"
        onChange={vi.fn()}
        disabled
        models={models}
        favoriteModels={[]}
      />,
    );
    const trigger = screen.getByRole('button', { name: /^Model:/ });
    expect(trigger.getAttribute('data-disabled')).not.toBeNull();
  });
});
