import { afterEach, describe, expect, it } from 'vitest';
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
  it('opens an informational popover without an unimplemented action', async () => {
    const user = userEvent.setup();
    render(<ContextUsageChip conversation={conversation} availableModels={models} />);
    await user.click(screen.getByRole('button', { name: 'Context usage' }));
    expect(await screen.findByText('Estimated context')).toBeTruthy();
    expect(screen.getByText('Model window')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull();
  });

  it('renders nothing when the model context window is unknown', () => {
    const { container } = render(
      <ContextUsageChip conversation={conversation} availableModels={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
