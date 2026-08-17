import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (u: string) => openUrl(u) }));

const isTauri = vi.fn();
vi.mock('../services/api', () => ({ isTauri: () => isTauri() }));

async function renderLink(href: string) {
  const { createMarkdownComponents } = await import('./wikiLinks');
  const components = createMarkdownComponents({});
  const Anchor = components.a as React.ComponentType<{ href?: string; children?: React.ReactNode }>;
  render(<Anchor href={href}>listen</Anchor>);
  return screen.getByText('listen');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const APPLE_MUSIC = 'https://music.apple.com/us/song/1651330689';

describe('external links', () => {
  it('in a browser, navigates natively instead of opening a popup', async () => {
    // Regression: cancelling the click and calling window.open turns a native
    // anchor activation into a programmatic popup. iOS opens that as a separate
    // tab, then hands off to the native app (Music, Maps) FROM that tab —
    // leaving a stranded blank tab behind Alloy that has to be closed by hand.
    isTauri.mockReturnValue(false);
    const link = await renderLink(APPLE_MUSIC);

    expect(link.getAttribute('href')).toBe(APPLE_MUSIC);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    // The click must NOT be intercepted; Safari handles the universal link.
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('in the desktop shell, hands the URL to the system browser', async () => {
    // Here interception IS required: an unhandled navigation would load the page
    // inside the webview, replacing Alloy itself.
    isTauri.mockReturnValue(true);
    const link = await renderLink(APPLE_MUSIC);

    await userEvent.click(link);

    expect(openUrl).toHaveBeenCalledWith(APPLE_MUSIC);
    expect(link.getAttribute('target')).toBeNull();
  });
});
