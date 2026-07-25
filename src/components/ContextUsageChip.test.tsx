import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextUsageChip } from './ContextUsageChip';
import type { Conversation, ModelInfo } from '../types';

const conversation = {
  id: 'c1',
  model: 'anthropic/claude-opus-4-6',
  messages: [{ id: 'm1', role: 'user', content: 'hello world' }],
} as unknown as Conversation;

const models: ModelInfo[] = [
  { key: 'anthropic/claude-opus-4-6', name: 'Claude Opus', contextWindow: 200000 },
];

afterEach(cleanup);

describe('ContextUsageChip', () => {
  it('opens a popover and triggers compaction', async () => {
    const onCompactNow = vi.fn();
    const user = userEvent.setup();
    render(<ContextUsageChip conversation={conversation} availableModels={models} onCompactNow={onCompactNow} />);
    await user.click(screen.getByRole('button', { name: 'Context usage' }));
    expect(await screen.findByText('Estimated context')).toBeTruthy();
    expect(screen.getByText('Model window')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(onCompactNow).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the model context window is unknown', () => {
    const { container } = render(
      <ContextUsageChip conversation={conversation} availableModels={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
