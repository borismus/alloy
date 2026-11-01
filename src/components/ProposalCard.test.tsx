import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { vaultService } from '../services/vault';
import { proposedPath } from '../services/proposals';
import { ProposalCard } from './ProposalCard';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.spyOn(vaultService, 'readVaultFile').mockImplementation(async path =>
    path === 'memory.md' ? '# Memory\n- likes tea\n' : path === 'skills/flux/SKILL.md' ? 'Old steps.\n' : null);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderCard(extra: Partial<React.ComponentProps<typeof ProposalCard>> = {}) {
  render(
    <ProposalCard
      conversationId="c1"
      messageId="m1"
      toolIndex={2}
      path="memory.md"
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
  expect(url).toContain('/api/proposal');
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

it('recognizes proposals across providers', () => {
  const content = '# Memory\n';
  const result = 'Proposed a change to memory.md. It has NOT been saved.';
  expect(proposedPath({ type: 'write_file', input: { path: 'memory.md', content }, result })).toBe('memory.md');
  expect(proposedPath({ type: 'mcp__alloy__write_file', input: { path: './memory.md', content }, result })).toBe('memory.md');
  expect(proposedPath({ type: 'write_file', input: { path: 'notes/memory.md', content }, result })).toBeNull();
  expect(proposedPath({ type: 'read_file', input: { path: 'memory.md' }, result })).toBeNull();
  expect(proposedPath({ type: 'write_file', input: { path: 'memory.md', content }, result, isError: true })).toBeNull();
});

it('ignores memory writes from before proposals existed, and no-ops', () => {
  const input = { path: 'memory.md', content: '# Memory\n' };
  expect(proposedPath({ type: 'write_file', input, result: 'Successfully wrote to memory.md' })).toBeNull();
  expect(proposedPath({ type: 'write_file', input, result: 'memory.md already says exactly this; nothing to change.' })).toBeNull();
  expect(proposedPath({ type: 'write_file', input })).toBeNull();
});

it('says so instead of offering an empty change', async () => {
  renderCard({ proposed: '# Memory\n- likes tea\n' });
  expect(await screen.findByText('Memory already matches this change.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
});

it('proposes skill changes against the current skill file', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ decision: 'accepted' }) });
  renderCard({ path: 'skills/flux/SKILL.md', proposed: 'New steps.\n' });

  expect(screen.getByText('skills/flux/SKILL.md')).toBeTruthy();
  expect(await screen.findByText(/New steps/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  await screen.findByText('Skill change accepted.');
});

it('recognizes skill proposals but not note writes', () => {
  const content = 'x';
  const skill = 'skills/flux/SKILL.md';
  expect(proposedPath({ type: 'mcp__alloy__write_file', input: { path: skill, content }, result: `Proposed a change to ${skill}. It has NOT been saved.` })).toBe(skill);
  // A result proposing a different file does not count.
  expect(proposedPath({ type: 'write_file', input: { path: skill, content }, result: 'Proposed a change to memory.md.' })).toBeNull();
  expect(proposedPath({ type: 'write_file', input: { path: 'notes/x.md', content }, result: 'Proposed a change to notes/x.md.' })).toBeNull();
  // The old denial, from before skill proposals existed.
  expect(proposedPath({ type: 'write_file', input: { path: skill, content }, result: 'Access denied: write…', isError: true })).toBeNull();
});
