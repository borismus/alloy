import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowedList } from './useWindowedList';

const ROW_HEIGHT = 100; // 92px tall + 8px margin — the margin is the point.
const VIEWPORT = 800;

/**
 * A scroll container whose rows are laid out on a fixed pitch. `offsetHeight`
 * deliberately excludes the margin, exactly as the browser reports it, so a
 * hook that measures height instead of pitch will under-count and be caught.
 */
function makeContainer(renderedCount: () => number) {
  const listeners = new Map<string, () => void>();
  const el = {
    scrollTop: 0,
    clientHeight: VIEWPORT,
    addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
    querySelectorAll: () => {
      const rows = [];
      for (let i = 0; i < renderedCount(); i++) {
        rows.push({
          offsetHeight: ROW_HEIGHT - 8,
          getBoundingClientRect: () => ({ top: i * ROW_HEIGHT }),
        });
      }
      return rows as unknown as NodeListOf<HTMLElement>;
    },
  };
  // Stable ref identity, matching the real component's useRef.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = { current: el as any };
  return { el, ref, scroll: (to: number) => { el.scrollTop = to; listeners.get('scroll')?.(); } };
}

beforeEach(() => {
  // jsdom has no ResizeObserver. Leave requestAnimationFrame alone — React
  // schedules through it, and replacing it with a synchronous stub sends the
  // renderer into unbounded recursion.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

/** Let the hook's rAF-coalesced scroll handler run. */
async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 32)); });
}

afterEach(() => vi.unstubAllGlobals());

describe('useWindowedList', () => {
  it('renders everything and adds no padding when disabled', () => {
    const { ref } = makeContainer(() => 0);
    const { result } = renderHook(() => useWindowedList({
      containerRef: ref,
      itemCount: 500,
      enabled: false,
    }));
    expect(result.current).toEqual({
      startIndex: 0, endIndex: 500, topPadding: 0, bottomPadding: 0,
    });
  });

  it('renders a small window of a long list and pads the rest', () => {
    let rendered = 0;
    const { ref } = makeContainer(() => rendered);
    const { result, rerender } = renderHook(() => useWindowedList({
      containerRef: ref,
      itemCount: 1300,
      enabled: true,
    }));
    rendered = result.current.endIndex - result.current.startIndex;
    rerender();

    const { startIndex, endIndex, topPadding, bottomPadding } = result.current;
    expect(startIndex).toBe(0);
    // One viewport of rows plus overscan — a tiny fraction of 1300.
    expect(endIndex).toBeGreaterThan(0);
    expect(endIndex).toBeLessThan(50);
    expect(topPadding).toBe(0);
    expect(bottomPadding).toBeGreaterThan(0);
  });

  // Regression: rows carry a bottom margin that offsetHeight omits. Measuring
  // height instead of row-to-row pitch under-counts ~8px per row, which over a
  // long list makes the end of the list unreachable.
  it('derives row pitch including margins, so total height matches the list', () => {
    let rendered = 0;
    const { ref } = makeContainer(() => rendered);
    const { result, rerender } = renderHook(() => useWindowedList({
      containerRef: ref,
      itemCount: 1000,
      enabled: true,
    }));
    rendered = result.current.endIndex - result.current.startIndex;
    rerender();

    const { startIndex, endIndex, topPadding, bottomPadding } = result.current;
    const renderedHeight = (endIndex - startIndex) * ROW_HEIGHT;
    expect(topPadding + renderedHeight + bottomPadding).toBe(1000 * ROW_HEIGHT);
  });

  it('moves the window as the container scrolls', async () => {
    let rendered = 0;
    const { ref, scroll } = makeContainer(() => rendered);
    const { result, rerender } = renderHook(() => useWindowedList({
      containerRef: ref,
      itemCount: 1000,
      enabled: true,
    }));
    rendered = result.current.endIndex - result.current.startIndex;
    rerender();
    expect(result.current.startIndex).toBe(0);

    await settle();
    scroll(500 * ROW_HEIGHT);
    await settle();
    rerender();
    // Around row 500, not anchored back at the top.
    expect(result.current.startIndex).toBeGreaterThan(480);
    expect(result.current.endIndex).toBeLessThan(540);
    expect(result.current.topPadding).toBeGreaterThan(0);

    // Scrolling to the end must reach the final row, not stop short.
    scroll(1000 * ROW_HEIGHT - VIEWPORT);
    await settle();
    rerender();
    expect(result.current.endIndex).toBe(1000);
    expect(result.current.bottomPadding).toBe(0);
  });
});
