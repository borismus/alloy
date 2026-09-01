import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import packageInfo from '../../package.json';
import { ThemeProvider } from '../theme';
import { vaultService } from '../services/vault';
import { Settings } from './Settings';

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      currentHost: 'legomenon',
      scheduledTaskRunner: 'smusmini',
      schedulerActive: false,
    }),
  }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows the current Alloy version in Updates', async () => {
  render(
    <ThemeProvider>
      <Settings
        onClose={vi.fn()}
        vaultPath="/tmp/alloy-vault"
        externalEditor="system"
        onExternalEditorChange={vi.fn()}
      />
    </ThemeProvider>
  );

  expect(screen.getByText(packageInfo.version).textContent).toBe(packageInfo.version);
  await screen.findByText(/Scheduled tasks run on/);
});

it('warns when no shared scheduled-task runner is assigned', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ currentHost: 'legomenon', schedulerActive: true }),
  } as Response);
  render(
    <ThemeProvider>
      <Settings
        onClose={vi.fn()}
        vaultPath="/tmp/alloy-vault"
        externalEditor="system"
        onExternalEditorChange={vi.fn()}
      />
    </ThemeProvider>
  );

  expect((await screen.findByText(/No runner is assigned/)).textContent)
    .toContain('Every Alloy machine');
  expect(screen.getByRole('button', { name: 'Run scheduled tasks on this machine' })).toBeTruthy();
});

it('shows the shared runner assignment and can assign the current server', async () => {
  const update = vi.spyOn(vaultService, 'updateConfigValue').mockResolvedValue();
  const user = userEvent.setup();
  render(
    <ThemeProvider>
      <Settings
        onClose={vi.fn()}
        vaultPath="/tmp/alloy-vault"
        externalEditor="system"
        onExternalEditorChange={vi.fn()}
      />
    </ThemeProvider>
  );

  expect((await screen.findByText(/Scheduled tasks run on/)).textContent).toContain('smusmini');
  expect(screen.getByText(/This server is/).textContent).toContain('legomenon');
  await user.click(screen.getByRole('button', { name: 'Run scheduled tasks on this machine' }));

  await waitFor(() => expect(update).toHaveBeenCalledWith('scheduledTaskRunner', 'legomenon'));
  expect(screen.getByText(/This machine/).textContent).toContain('legomenon');
  expect(screen.getByText(/Activation can take up to a minute/)).toBeTruthy();
});
