import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from './theme';

function Harness() {
  const { preference, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="pref">{preference}</span>
      <button onClick={() => setPreference('dark')}>set dark</button>
      <button onClick={() => setPreference('light')}>set light</button>
      <button onClick={() => setPreference('system')}>set system</button>
    </div>
  );
}

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

beforeEach(() => {
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe('theme', () => {
  it('defaults to light and applies the attribute to <html>', () => {
    render(<ThemeProvider><Harness /></ThemeProvider>);
    expect(screen.getByTestId('pref').textContent).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('switches to dark, applies the attribute, and persists the preference', () => {
    render(<ThemeProvider><Harness /></ThemeProvider>);
    fireEvent.click(screen.getByText('set dark'));
    expect(screen.getByTestId('pref').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('alloy.theme')).toBe('dark');
  });

  it('resolves system to the OS color scheme', () => {
    mockMatchMedia(true); // OS prefers dark
    render(<ThemeProvider><Harness /></ThemeProvider>);
    fireEvent.click(screen.getByText('set system'));
    expect(screen.getByTestId('pref').textContent).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('restores a stored preference on mount', () => {
    localStorage.setItem('alloy.theme', 'dark');
    render(<ThemeProvider><Harness /></ThemeProvider>);
    expect(screen.getByTestId('pref').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
