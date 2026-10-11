import { RefObject, useEffect, useLayoutEffect, useRef, useState, useCallback, UIEvent, WheelEvent, TouchEvent } from 'react';

interface UseAutoScrollOptions {
  /** The scrollable container (the element with `overflow-y: auto`). */
  containerRef: RefObject<HTMLElement | null>;
  /** How close to the bottom (px) still counts as "at the bottom". Only
   *  absorbs sub-pixel rounding: following means being fully at the bottom. */
  threshold?: number;
}

interface ScrollProps {
  onScroll: (e: UIEvent<HTMLElement>) => void;
  onWheel: (e: WheelEvent<HTMLElement>) => void;
  onTouchStart: (e: TouchEvent<HTMLElement>) => void;
  onTouchMove: (e: TouchEvent<HTMLElement>) => void;
}

interface UseAutoScrollReturn {
  shouldAutoScroll: boolean;
  /** `true` also scrolls to the bottom now (sending a message, switching). */
  setShouldAutoScroll: (value: boolean) => void;
  /** Spread onto the scroll container. */
  scrollProps: ScrollProps;
}

/**
 * Stick-to-bottom for a streaming scroll container.
 *
 * Rule:
 *  1. While the viewport is at the bottom, keep it pinned there as the content
 *     grows — text, tool calls, thinking, sub-agents, late-loading images,
 *     anything.
 *  2. The moment the user scrolls up (wheel, scrollbar, or touch), stop
 *     following until they're back at the bottom.
 *
 * The pin fires only when the content or the viewport actually changed size,
 * never merely because React re-rendered. Pinning on every render snapped the
 * view back while the user was scrolling, even with nothing streaming (an
 * autoscroll dependency was a fresh `[]` on every render). The check runs in a
 * layout effect so a new chunk is never painted before the pin; a
 * ResizeObserver catches growth that happens without a render.
 *
 * Unsticking reads the user's *intent* (the wheel or touch gesture), not just
 * the scroll position: a fast stream can re-pin before the `scroll` handler
 * reads the position, so position alone would never see the scroll-up.
 */
export function useAutoScroll(options: UseAutoScrollOptions): UseAutoScrollReturn {
  const { containerRef, threshold = 2 } = options;
  const [shouldAutoScroll, setShouldAutoScrollState] = useState(true);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const lastSizeRef = useRef({ content: -1, viewport: -1 });
  const touchYRef = useRef<number | null>(null);

  const setStick = useCallback((value: boolean) => {
    if (stickRef.current === value) return;
    stickRef.current = value;
    setShouldAutoScrollState(value);
  }, []);

  const pinToBottom = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, []);

  /** Pin if following and the content or viewport changed size since last time. */
  const follow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const size = { content: el.scrollHeight, viewport: el.clientHeight };
    const last = lastSizeRef.current;
    lastSizeRef.current = size;
    if (size.content === last.content && size.viewport === last.viewport) return;
    if (stickRef.current) pinToBottom(el);
  }, [containerRef, pinToBottom]);

  const setShouldAutoScroll = useCallback((value: boolean) => {
    stickRef.current = value;
    setShouldAutoScrollState(value);
    const el = containerRef.current;
    if (value && el) pinToBottom(el);
  }, [containerRef, pinToBottom]);

  // Growth without a render: images and embeds loading, collapsibles opening,
  // the software keyboard resizing the viewport. Attached to whichever element
  // the ref holds, since the container can mount after this hook does.
  const observedRef = useRef<{ el: HTMLElement; disconnect: () => void } | null>(null);
  const observe = useCallback(() => {
    const el = containerRef.current;
    if (observedRef.current?.el === el) return;
    observedRef.current?.disconnect();
    observedRef.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    lastSizeRef.current = { content: -1, viewport: -1 };
    const resize = new ResizeObserver(follow);
    resize.observe(el);
    for (const child of Array.from(el.children)) resize.observe(child);
    const children = new MutationObserver(records => {
      for (const record of records) {
        record.addedNodes.forEach(node => { if (node instanceof Element) resize.observe(node); });
        record.removedNodes.forEach(node => { if (node instanceof Element) resize.unobserve(node); });
      }
    });
    children.observe(el, { childList: true });
    observedRef.current = {
      el,
      disconnect: () => {
        resize.disconnect();
        children.disconnect();
      },
    };
  }, [containerRef, follow]);

  // After every render, before paint. Cheap when nothing changed: it compares
  // two numbers and doesn't touch the scroll position.
  useLayoutEffect(() => {
    observe();
    follow();
  });

  useEffect(() => () => observedRef.current?.disconnect(), []);

  const onScroll = useCallback(
    (e: UIEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
      const movedUp = el.scrollTop < lastTopRef.current - 1;
      lastTopRef.current = el.scrollTop;
      // Re-stick once back at the bottom; unstick on any upward move (covers
      // scrollbar drags, which don't emit a wheel event).
      if (atBottom) setStick(true);
      else if (movedUp) setStick(false);
    },
    [threshold, setStick]
  );

  const onWheel = useCallback(
    (e: WheelEvent<HTMLElement>) => {
      if (e.deltaY < 0) setStick(false);
    },
    [setStick]
  );

  const onTouchStart = useCallback((e: TouchEvent<HTMLElement>) => {
    touchYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const onTouchMove = useCallback(
    (e: TouchEvent<HTMLElement>) => {
      const y = e.touches[0]?.clientY;
      const start = touchYRef.current;
      if (y === undefined || start === null) return;
      // A finger moving down scrolls the content up.
      if (y > start + 2) setStick(false);
      touchYRef.current = y;
    },
    [setStick]
  );

  return {
    shouldAutoScroll,
    setShouldAutoScroll,
    scrollProps: { onScroll, onWheel, onTouchStart, onTouchMove },
  };
}
