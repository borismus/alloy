import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TitleSuggestions } from './TitleSuggestions';

const fetchMock = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
}

it('shows three suggestions and fills the field with the one picked', async () => {
  respond(200, { titles: ['Exiting the Contract', 'Termination Costs', 'Switching Managers'] });
  const onPick = vi.fn();
  render(<TitleSuggestions conversationId="conv-1" onPick={onPick} />);

  expect(screen.getByText('Suggesting titles…')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Termination Costs' }));

  expect(onPick).toHaveBeenCalledWith('Termination Costs');
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(fetchMock.mock.calls[0][0]).toContain('/api/conversations/conv-1/title-suggestions');
});

it('explains why when the server refuses', async () => {
  respond(409, { error: 'This conversation holds private material' });
  render(<TitleSuggestions conversationId="conv-1" onPick={vi.fn()} />);
  expect(await screen.findByText(/holds private material/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
