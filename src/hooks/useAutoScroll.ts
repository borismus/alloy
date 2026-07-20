import { RefObject, useEffect, useRef, useState, useCallback, UIEvent } from 'react';

interface UseAutoScrollOptions {
  /** The scrollable container (the element with `overflow-y: auto`). */
  containerRef: RefObject<HTMLElement | null>;
  /** Values that, when they change, may have grown the content (stream chunks). */
  dependencies: unknown[];
  /** How close to the bottom (px) still counts as "at the bottom". */
  threshold?: number;
}

interface UseAutoScrollReturn {
  shouldAutoScroll: boolean;
  setShouldAutoScroll: (value: boolean) => void;
  handleScroll: (e: UIEvent<HTMLElement>) => void;
}

/**
 * Stick-to-bottom for a streaming scroll container.
 *
 * Rule:
 *  1. While the viewport is at (within `threshold` px of) the bottom, keep it
 *     pinned to the bottom as content grows.
 *  2. The moment the user scrolls up, stop following and don't move the
 *     viewport again until they scroll back to the bottom.
 *
 * The follow decision is derived purely from the container's live scroll
 * position and stored in a ref that's updated synchronously on every scroll
 * event. A programmatic pin leaves us exactly at the bottom, so its own scroll
 * event simply re-affirms "stuck" — there's no fragile "ignore my own scroll"
 * flag, and a real user scroll-up is never mistaken for a pin (which is what
 * caused the old snap-back).
 */
export function useAutoScroll(options: UseAutoScrollOptions): UseAutoScrollReturn {
  const { containerRef, dependencies, threshold = 50 } = options;
  const [shouldAutoScroll, setShouldAutoScrollState] = useState(true);
  // Synchronous mirror so the content-change effect reads the latest decision
  // before React re-renders.
  const stickRef = useRef(true);

  const setShouldAutoScroll = useCallback((value: boolean) => {
    stickRef.current = value;
    setShouldAutoScrollState(value);
  }, []);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
      if (atBottom !== stickRef.current) {
        stickRef.current = atBottom;
        setShouldAutoScrollState(atBottom);
      }
    },
    [threshold]
  );

  useEffect(() => {
    if (!stickRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    // Pin instantly (not smooth): a smooth animation lags fast-growing stream
    // content and its intermediate positions read as "not at bottom".
    el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, ...dependencies]);

  return { shouldAutoScroll, setShouldAutoScroll, handleScroll };
}
