import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Render only the visible slice of a long scrolling list.
 *
 * A vault with ~1,300 conversations put every row in the DOM at once (13k
 * nodes), which cost ~1s on load and made each selection change reconcile the
 * whole list. Rows are uniform enough that a single measured row height gives
 * accurate offsets; the estimate self-corrects from the rows actually on
 * screen, so it adapts to font size and viewport instead of trusting a
 * hardcoded constant.
 *
 * Deliberately inert for short lists (see `enabled`), so small vaults keep
 * today's behaviour — including the reorder animation, which needs the rows it
 * animates to be present.
 */

/** Fallback until real rows can be measured. */
const DEFAULT_ROW_HEIGHT = 84;

/** Rows rendered beyond each edge, absorbing fast scrolls and height drift. */
const DEFAULT_OVERSCAN = 8;

/** Sample size for recalibrating row height — enough to average out variation. */
const MEASURE_SAMPLE = 10;

/** Ignore sub-pixel noise; only react to a materially different row height. */
const HEIGHT_EPSILON = 0.5;

/**
 * Weight of a fresh measurement when refining the estimate. Rows vary in height
 * (a title may wrap to one line or two), so each window measures a slightly
 * different average; smoothing converges instead of chasing whichever rows are
 * currently on screen.
 */
const HEIGHT_SMOOTHING = 0.3;

export interface WindowedRange {
  /** First rendered index. */
  startIndex: number;
  /** One past the last rendered index. */
  endIndex: number;
  /** Spacer height standing in for rows before `startIndex`. */
  topPadding: number;
  /** Spacer height standing in for rows after `endIndex`. */
  bottomPadding: number;
}

interface Options {
  containerRef: React.RefObject<HTMLElement | null>;
  itemCount: number;
  /** False renders everything, making this hook a no-op. */
  enabled: boolean;
  overscan?: number;
}

export function useWindowedList({
  containerRef,
  itemCount,
  enabled,
  overscan = DEFAULT_OVERSCAN,
}: Options): WindowedRange {
  const rowHeightRef = useRef(DEFAULT_ROW_HEIGHT);
  const calibratedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const [range, setRange] = useState({ start: 0, end: itemCount });

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rowHeight = Math.max(1, rowHeightRef.current);
    // Strictly a window: the rendered range tracks the scroll position and
    // never spans to an off-screen index. Anchoring it to something far away
    // (an out-of-view selection, say) would render everything in between and
    // defeat the whole point.
    const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
    const visibleRows = Math.ceil(el.clientHeight / rowHeight) + overscan * 2;
    const end = Math.min(itemCount, start + visibleRows);
    setRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [containerRef, itemCount, overscan]);

  // Recalibrate from real rows. Measure the row-to-row *pitch* rather than each
  // row's own height: rows carry a bottom margin, which offsetHeight excludes,
  // and under-counting even 8px per row compounds over a thousand rows into a
  // list whose end cannot be scrolled to. Pitch also absorbs any gap or border
  // without needing to know the stylesheet. Sampling a handful of rows keeps
  // this far cheaper than the full-list measurement the reorder animation does.
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>('[data-item-id]');
    if (rows.length === 0) return;

    const sample = Math.min(rows.length, MEASURE_SAMPLE);
    let measured: number;
    if (sample > 1) {
      const firstTop = rows[0].getBoundingClientRect().top;
      const lastTop = rows[sample - 1].getBoundingClientRect().top;
      measured = (lastTop - firstTop) / (sample - 1);
    } else {
      measured = rows[0].offsetHeight;
    }
    if (measured <= 0) return;

    const next = calibratedRef.current
      ? rowHeightRef.current * (1 - HEIGHT_SMOOTHING) + measured * HEIGHT_SMOOTHING
      : measured;
    const changed = Math.abs(next - rowHeightRef.current) > HEIGHT_EPSILON;
    rowHeightRef.current = next;

    // Measuring must not drive a render, or variable row heights loop forever:
    // recomputing swaps in a different set of rows, whose average differs, which
    // recomputes again. Only the very first calibration corrects the range
    // directly; later refinements are picked up by the next scroll or resize,
    // which is exactly when they matter.
    if (!calibratedRef.current) {
      calibratedRef.current = true;
      if (changed) recompute();
    }
  });

  useEffect(() => {
    if (!enabled) {
      // Functional + identity-preserving: this effect can re-run for reasons
      // outside our control, and handing React a fresh object with identical
      // fields would schedule another render every time, forever.
      setRange(prev => (prev.start === 0 && prev.end === itemCount
        ? prev
        : { start: 0, end: itemCount }));
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    // Coalesce scroll bursts into one update per frame.
    const onScroll = () => {
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        recompute();
      });
    };

    recompute();
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => recompute());
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [containerRef, enabled, itemCount, recompute]);

  if (!enabled) {
    return { startIndex: 0, endIndex: itemCount, topPadding: 0, bottomPadding: 0 };
  }

  const start = Math.min(range.start, Math.max(0, itemCount - 1));
  const end = Math.min(range.end, itemCount);
  const rowHeight = rowHeightRef.current;
  return {
    startIndex: start,
    endIndex: end,
    topPadding: start * rowHeight,
    bottomPadding: Math.max(0, (itemCount - end) * rowHeight),
  };
}
