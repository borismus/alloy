import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import packageInfo from '../../package.json';
import { ThemeProvider } from '../theme';
import { Settings } from './Settings';

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('shows the current Alloy version in Updates', () => {
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
});
