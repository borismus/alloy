import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoResizeTextarea } from './useAutoResizeTextarea';

/** scrollHeight is 0 in happy-dom, so drive it explicitly. */
function textareaWithScrollHeight(height: () => number) {
  const el = document.createElement('textarea');
  Object.defineProperty(el, 'scrollHeight', { get: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useAutoResizeTextarea', () => {
  it('sizes the textarea to its content', () => {
    const el = textareaWithScrollHeight(() => 120);
    renderHook(() => useAutoResizeTextarea({ current: el }, 'some text'));
    expect(el.style.height).toBe('120px');
  });

  it('re-measures on rotation, when the value has not changed', () => {
    // Regression: the height is written inline from scrollHeight, and the hook
    // only re-ran on [ref, value]. Rotating changes the composer's width and so
    // how text wraps, without changing the value — leaving a tall box from the
    // previous orientation on screen, even when empty.
    let scrollHeight = 200;
    const el = textareaWithScrollHeight(() => scrollHeight);
    renderHook(() => useAutoResizeTextarea({ current: el }, ''));
    expect(el.style.height).toBe('200px');

    // Landscape: same content now fits on one line.
    scrollHeight = 48;
    window.dispatchEvent(new Event('orientationchange'));

    expect(el.style.height).toBe('48px');
  });

  it('re-measures when the software keyboard resizes the visual viewport', () => {
    const listeners: Array<() => void> = [];
    Object.defineProperty(window, 'visualViewport', {
      value: {
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: () => {},
      },
      configurable: true,
    });

    let scrollHeight = 160;
    const el = textareaWithScrollHeight(() => scrollHeight);
    renderHook(() => useAutoResizeTextarea({ current: el }, 'hi'));

    scrollHeight = 48;
    listeners.forEach((fn) => fn());

    expect(el.style.height).toBe('48px');
  });

  it('stops measuring after unmount', () => {
    let scrollHeight = 100;
    const el = textareaWithScrollHeight(() => scrollHeight);
    const { unmount } = renderHook(() => useAutoResizeTextarea({ current: el }, 'x'));
    unmount();

    scrollHeight = 999;
    window.dispatchEvent(new Event('orientationchange'));

    expect(el.style.height).toBe('100px');
  });
});
