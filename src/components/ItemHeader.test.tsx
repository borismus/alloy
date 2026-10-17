import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemHeader } from './ItemHeader';
import { HeaderActionsProvider } from '../contexts/HeaderActionsContext';

afterEach(cleanup);

describe('ItemHeader actions', () => {
  it('offers new conversation and settings when the app provides them', async () => {
    const newConversation = vi.fn();
    const openSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <HeaderActionsProvider value={{ newConversation, openSettings }}>
        <ItemHeader title="Conversation" onBack={vi.fn()} />
      </HeaderActionsProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(newConversation).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('renders neither action without the app context', () => {
    render(<ItemHeader title="Conversation" onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
  });

  it('uses the shared accessible button and optional subtitle patterns', () => {
    render(
      <ItemHeader
        title="Conversation"
        subtitle="Claude subscription"
        onBack={vi.fn()}
        canGoBack={false}
      />,
    );

    const back = screen.getByRole('button', { name: 'Go back' });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    expect(back.className.split(' ').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Claude subscription')).toBeTruthy();
  });
});
