import { RefObject, useEffect, useRef, useState, useCallback, UIEvent, WheelEvent } from 'react';

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
  /** Wire to the container's `onScroll`. */
  handleScroll: (e: UIEvent<HTMLElement>) => void;
  /** Wire to the container's `onWheel`. */
  handleWheel: (e: WheelEvent<HTMLElement>) => void;
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
 * Why not derive the follow decision from the scroll position alone: a fast
 * stream re-pins to the bottom every chunk, and that pin can overwrite the
 * user's scroll-up *before* the `scroll` handler reads the position — so the
 * handler sees "at bottom" and never unsticks (the snap-back). Instead we
 * unstick from the user's *intent* (the `wheel`/touch gesture), which fires
 * regardless of where the pin lands, and only re-stick once they're genuinely
 * back at the bottom. A synchronous ref holds the decision so the next chunk's
 * pin effect sees it immediately.
 */
export function useAutoScroll(options: UseAutoScrollOptions): UseAutoScrollReturn {
  const { containerRef, dependencies, threshold = 50 } = options;
  const [shouldAutoScroll, setShouldAutoScrollState] = useState(true);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);

  const setStick = useCallback((value: boolean) => {
    if (stickRef.current === value) return;
    stickRef.current = value;
    setShouldAutoScrollState(value);
  }, []);

  const setShouldAutoScroll = useCallback((value: boolean) => {
    stickRef.current = value;
    setShouldAutoScrollState(value);
  }, []);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
      const movedUp = el.scrollTop < lastTopRef.current - 2;
      lastTopRef.current = el.scrollTop;
      // Re-stick once genuinely back at the bottom; unstick on any upward move
      // (covers scrollbar drags / touch, which don't emit a wheel event).
      if (atBottom) setStick(true);
      else if (movedUp) setStick(false);
    },
    [threshold, setStick]
  );

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLElement>) => {
      // User intent to scroll up — definitive, and survives a racing re-pin
      // because it doesn't depend on the resulting scroll position.
      if (e.deltaY < 0) setStick(false);
    },
    [setStick]
  );

  useEffect(() => {
    if (!stickRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    // Pin instantly (not smooth): a smooth animation lags fast-growing stream
    // content and its intermediate positions read as "not at bottom".
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, ...dependencies]);

  return { shouldAutoScroll, setShouldAutoScroll, handleScroll, handleWheel };
}
