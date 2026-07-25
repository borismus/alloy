import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RiffBatchApprovalModal } from './RiffBatchApprovalModal';
import type { ProposedChange } from '../types';

const changes: ProposedChange[] = [
  { type: 'create', path: 'notes/topic.md', description: 'Create a note', newContent: 'Hello', reasoning: 'Because' },
  { type: 'append', path: 'memory.md', description: 'Remember this', newContent: 'World', reasoning: 'Durable' },
];

afterEach(cleanup);

describe('RiffBatchApprovalModal', () => {
  it('lists proposed changes and applies them', async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<RiffBatchApprovalModal proposedChanges={changes} isProcessing={false} onApply={onApply} onCancel={onCancel} />);
    expect(screen.getByRole('heading', { name: 'Integrate Insights' })).toBeTruthy();
    expect(screen.getByText('notes/topic.md')).toBeTruthy();
    expect(screen.getByText('memory.md')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Apply All' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('cancels via the Cancel button', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<RiffBatchApprovalModal proposedChanges={changes} isProcessing={false} onApply={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('expands a change to reveal its content via a disclosure', async () => {
    const user = userEvent.setup();
    render(<RiffBatchApprovalModal proposedChanges={changes} isProcessing={false} onApply={vi.fn()} onCancel={vi.fn()} />);
    const triggers = screen.getAllByRole('button', { name: 'View content' });
    expect(triggers).toHaveLength(2);
    expect(triggers[0].getAttribute('aria-expanded')).toBe('false');
    await user.click(triggers[0]);
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the empty state with a single Done action', () => {
    render(<RiffBatchApprovalModal proposedChanges={[]} isProcessing={false} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Integration Complete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
