import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextUsageChip } from './ContextUsageChip';
import type { Conversation, Message, ModelInfo } from '../types';

/** ~4 chars/token + 10 overhead, matching the chip's own estimate. */
function conversationOfTokens(tokens: number): Conversation {
  const messages: Message[] = [{
    id: 'm1',
    role: 'user',
    timestamp: '2024-01-01T00:00:00Z',
    content: 'x'.repeat(Math.max(0, (tokens - 10) * 4)),
  }];
  return { id: 'c1', model: 'mlx/qwen', messages } as unknown as Conversation;
}

const models: ModelInfo[] = [
  { key: 'mlx/qwen', name: 'Qwen', contextWindow: 262_144 },
];

const compaction = { enabled: true, triggerTokens: 16_000 };

afterEach(cleanup);

describe('ContextUsageChip', () => {
  it('measures the thread against the compaction threshold, not the context window', () => {
    // The window is 262k, but the server folds older turns at 16k — showing the
    // window left the chip calm while compaction was already running.
    render(
      <ContextUsageChip
        conversation={conversationOfTokens(8_000)}
        availableModels={models}
        compaction={compaction}
      />,
    );
    expect(screen.getByRole('button', { name: 'Context usage' }).textContent)
      .toContain('16.0K');
    expect(screen.getByRole('button', { name: 'Context usage' }).textContent)
      .not.toContain('262');
  });

  it('says older turns are being summarised once past the threshold', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ContextUsageChip
        conversation={conversationOfTokens(18_000)}
        availableModels={models}
        compaction={compaction}
      />,
    );
    // Compaction is normal operation, so this must not read as a fault.
    expect(container.querySelector('.ctx-chip-compacting')).toBeTruthy();
    expect(container.querySelector('.ctx-chip-hot')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Context usage' }));
    expect(await screen.findByText('Compacts above')).toBeTruthy();
    expect(screen.getByText(/Older turns are being summarised/)).toBeTruthy();
  });

  it('clamps the threshold for models whose window is smaller than it', () => {
    // Mirrors effective_budget's 0.6x clamp: a 16k trigger cannot apply to an
    // 8k model, where compaction really starts at 4.8k.
    render(
      <ContextUsageChip
        conversation={conversationOfTokens(1_000)}
        availableModels={[{ key: 'mlx/qwen', name: 'Small', contextWindow: 8_192 }]}
        compaction={compaction}
      />,
    );
    expect(screen.getByRole('button', { name: 'Context usage' }).textContent)
      .toContain('4.9K');
  });

  it('falls back to the context window when compaction is off', async () => {
    const user = userEvent.setup();
    render(
      <ContextUsageChip
        conversation={conversationOfTokens(8_000)}
        availableModels={models}
        compaction={{ enabled: false, triggerTokens: 16_000 }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Context usage' }).textContent)
      .toContain('262.1K');
    await user.click(screen.getByRole('button', { name: 'Context usage' }));
    expect(await screen.findByText('Model window')).toBeTruthy();
  });

  it('opens an informational popover without an unimplemented action', async () => {
    const user = userEvent.setup();
    render(
      <ContextUsageChip
        conversation={conversationOfTokens(500)}
        availableModels={models}
        compaction={compaction}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Context usage' }));
    expect(await screen.findByText('Estimated context')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull();
  });

  it('renders nothing when neither a threshold nor a window is known', () => {
    const { container } = render(
      <ContextUsageChip conversation={conversationOfTokens(500)} availableModels={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
