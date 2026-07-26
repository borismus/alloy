import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemHeader } from './ItemHeader';
import { SettingsLauncherProvider } from '../contexts/SettingsLauncherContext';

afterEach(cleanup);

describe('ItemHeader settings gear', () => {
  it('renders a settings gear that opens settings when a launcher is provided', async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsLauncherProvider open={open}>
        <ItemHeader title="Conversation" onBack={vi.fn()} />
      </SettingsLauncherProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('renders no gear without a launcher context', () => {
    render(<ItemHeader title="Conversation" onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
  });
});
