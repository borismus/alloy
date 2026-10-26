import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderActionsProvider } from '../contexts/HeaderActionsContext';
import { getDebugOverlay } from '../services/debugOverlay';
import { HeaderActions, OVERLAY_LONG_PRESS_MS } from './HeaderActions';

function renderActions() {
  const openSettings = vi.fn();
  render(
    <HeaderActionsProvider value={{ newConversation: vi.fn(), openSettings }}>
      <HeaderActions />
    </HeaderActionsProvider>,
  );
  return { openSettings, gear: screen.getByRole('button', { name: 'Open settings' }) };
}

describe('HeaderActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // The events a real press sends, in order. React Aria fires onPress from the click.
  function hold(gear: HTMLElement, ms: number) {
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, width: 1, height: 1, pressure: 0.5, detail: 1 };
    fireEvent.pointerDown(gear, pointer);
    act(() => { vi.advanceTimersByTime(ms); });
    fireEvent.pointerUp(gear, pointer);
    fireEvent.click(gear, { detail: 1 });
  }

  it('opens settings on a tap without touching the overlay', () => {
    const { openSettings, gear } = renderActions();
    hold(gear, 100);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(getDebugOverlay()).toBe(false);
  });

  it('toggles the debug overlay on a long press instead of opening settings', () => {
    const { openSettings, gear } = renderActions();
    hold(gear, OVERLAY_LONG_PRESS_MS);
    expect(getDebugOverlay()).toBe(true);
    hold(gear, OVERLAY_LONG_PRESS_MS);
    expect(getDebugOverlay()).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();
  });
});
