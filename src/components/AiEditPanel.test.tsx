import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../types';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../services/server-streaming', () => ({ executeChatOnce: execute }));

import { AiEditPanel } from './AiEditPanel';

const LOCAL: ModelInfo = { key: 'mlx/qwen', name: 'Qwen', provider: 'mlx', local: true };
const CLOUD: ModelInfo = { key: 'openrouter/anthropic/claude', name: 'Claude', provider: 'openrouter' };

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  execute.mockResolvedValue({ content: 'revised note' });
});

afterEach(() => {
  cleanup();
  execute.mockReset();
});

function renderPanel(defaultModel: string, isPrivate: boolean) {
  render(
    <AiEditPanel
      placeholder="Edit this note"
      getCurrentContent={() => 'private body'}
      buildSystemPrompt={(current) => `edit: ${current}`}
      applyNewContent={vi.fn()}
      defaultModel={defaultModel}
      availableModels={[LOCAL, CLOUD]}
      isPrivate={isPrivate}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText('Edit this note'), { target: { value: 'tighten it' } });
  fireEvent.click(screen.getByRole('button', { name: 'Propose edit' }));
}

it('asks before sending a private note to a cloud model, and sends only once confirmed', async () => {
  renderPanel(CLOUD.key, true);

  expect(await screen.findByText(/only local models can read it/)).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0][0]).toBe(CLOUD.key);
});

it('sends nothing when the warning is cancelled', async () => {
  renderPanel(CLOUD.key, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(execute).not.toHaveBeenCalled();
});

it('does not ask for a local model or an ordinary note', async () => {
  renderPanel(LOCAL.key, true);
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/only local models can read it/)).toBeNull();
  cleanup();
  execute.mockClear();

  renderPanel(CLOUD.key, false);
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/only local models can read it/)).toBeNull();
});
