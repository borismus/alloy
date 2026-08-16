import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVisualViewport } from './useVisualViewport';

type Listener = () => void;

/** Minimal stand-in for window.visualViewport with controllable metrics. */
function installViewport(height: number, offsetTop = 0) {
  const listeners: Record<string, Listener[]> = {};
  const vv = {
    height,
    offsetTop,
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    },
    emit: (type: string) => (listeners[type] ?? []).forEach((l) => l()),
    listenerCount: () => Object.values(listeners).flat().length,
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true, writable: true });
  return vv;
}

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom has no rAF timing; run the callback immediately.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  document.documentElement.style.cssText = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useVisualViewport', () => {
  it('publishes the viewport height on mount', () => {
    installViewport(800);
    renderHook(() => useVisualViewport());
    expect(appHeight()).toBe('800px');
  });

  it('re-reads after an orientation change reports settled metrics late', () => {
    // The bug: iOS reports transitional metrics while the rotation animates and
    // may not fire a final visualViewport resize, so a single measurement at
    // event time keeps the PREVIOUS orientation's height — and every scroll
    // container sized from it gets the wrong extent.
    const vv = installViewport(800);
    renderHook(() => useVisualViewport());
    expect(appHeight()).toBe('800px');

    // Rotation begins; the viewport still reports the old height.
    window.dispatchEvent(new Event('orientationchange'));
    expect(appHeight()).toBe('800px');

    // It settles to the landscape height only after the animation, with no
    // further visualViewport event.
    vv.height = 390;
    vi.advanceTimersByTime(1000);

    expect(appHeight()).toBe('390px');
  });

  it('still tracks plain visualViewport resizes (software keyboard)', () => {
    const vv = installViewport(800);
    renderHook(() => useVisualViewport());

    vv.height = 400;
    vv.emit('resize');

    expect(appHeight()).toBe('400px');
  });

  it('removes every listener and pending timer on unmount', () => {
    const vv = installViewport(800);
    const { unmount } = renderHook(() => useVisualViewport());
    window.dispatchEvent(new Event('orientationchange'));

    unmount();
    vv.height = 123;
    vi.advanceTimersByTime(1000);
    vv.emit('resize');

    // No writes after unmount.
    expect(appHeight()).toBe('800px');
    expect(vv.listenerCount()).toBe(0);
  });
});
