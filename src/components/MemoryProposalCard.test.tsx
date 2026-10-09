import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { vaultService } from '../services/vault';
import { isMemoryProposal } from '../services/memoryProposals';
import { MemoryProposalCard } from './MemoryProposalCard';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.spyOn(vaultService, 'loadMemory').mockResolvedValue({ content: '# Memory\n- likes tea\n', sizeBytes: 22 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderCard(extra: Partial<React.ComponentProps<typeof MemoryProposalCard>> = {}) {
  render(
    <MemoryProposalCard
      conversationId="c1"
      messageId="m1"
      toolIndex={2}
      proposed={'# Memory\n- likes tea\n- moved to Seattle\n'}
      {...extra}
    />,
  );
}

it('shows the change as a diff and writes only when accepted', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ decision: 'accepted' }) });
  renderCard();

  expect(await screen.findByText(/moved to Seattle/)).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  await screen.findByText('Memory change accepted.');
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain('/api/memory/proposal');
  expect(JSON.parse(init.body)).toEqual({ conversationId: 'c1', messageId: 'm1', toolIndex: 2, accept: true });
});

it('rejects without accepting', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ decision: 'rejected' }) });
  renderCard();
  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  await screen.findByText('Memory change rejected.');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).accept).toBe(false);
});

it('warns when the conversation holds private material', async () => {
  renderCard({ isPrivateConversation: true });
  expect(await screen.findByText(/holds private material/)).toBeTruthy();
});

it('shows a recorded decision instead of buttons', () => {
  renderCard({ decision: 'accepted' });
  expect(screen.getByText('Memory change accepted.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
});

it('keeps the proposal when the server refuses', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'This change was already accepted.' }) });
  renderCard();
  fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
  await waitFor(() => expect(screen.getByText('This change was already accepted.')).toBeTruthy());
});

it('recognizes memory proposals across providers', () => {
  const content = '# Memory\n';
  const result = 'Proposed a change to memory.md. It has NOT been saved.';
  expect(isMemoryProposal({ type: 'write_file', input: { path: 'memory.md', content }, result })).toBe(true);
  expect(isMemoryProposal({ type: 'mcp__alloy__write_file', input: { path: './memory.md', content }, result })).toBe(true);
  expect(isMemoryProposal({ type: 'write_file', input: { path: 'notes/memory.md', content }, result })).toBe(false);
  expect(isMemoryProposal({ type: 'read_file', input: { path: 'memory.md' }, result })).toBe(false);
  expect(isMemoryProposal({ type: 'write_file', input: { path: 'memory.md', content }, result, isError: true })).toBe(false);
});

it('ignores memory writes from before proposals existed, and no-ops', () => {
  const input = { path: 'memory.md', content: '# Memory\n' };
  expect(isMemoryProposal({ type: 'write_file', input, result: 'Successfully wrote to memory.md' })).toBe(false);
  expect(isMemoryProposal({ type: 'write_file', input, result: 'memory.md already says exactly this; nothing to change.' })).toBe(false);
  expect(isMemoryProposal({ type: 'write_file', input })).toBe(false);
});

it('says so instead of offering an empty change', async () => {
  renderCard({ proposed: '# Memory\n- likes tea\n' });
  expect(await screen.findByText('Memory already matches this change.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
});
