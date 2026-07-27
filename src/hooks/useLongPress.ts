import { useCallback, useRef } from 'react';

interface LongPressOptions {
  /** How long (ms) the touch must be held before firing. */
  delay?: number;
  /** Movement (px) beyond which the gesture is treated as a scroll and cancelled. */
  moveTolerance?: number;
}

/**
 * Touch long-press detection, for opening context menus on mobile where there
 * is no right-click and iOS never fires `contextmenu`.
 *
 * `getHandlers(item)` returns touch handlers bound to `item`; spread them on the
 * element. A single set of timers is shared across items (only one touch gesture
 * happens at a time), so this can be called once and reused across a list.
 *
 * When the press fires it sets `didLongPress.current = true` and, on the ensuing
 * `touchend`, calls `preventDefault()` to suppress the synthesized `click` /
 * `mousedown` — so the element's own click (e.g. row selection) doesn't run and
 * the just-opened menu isn't immediately dismissed by the release. Consumers
 * should also guard their `onClick` with `didLongPress` and reset it there.
 */
export function useLongPress<T>(
  onLongPress: (item: T) => void,
  { delay = 500, moveTolerance = 10 }: LongPressOptions = {},
) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  const getHandlers = useCallback(
    (item: T) => ({
      onTouchStart: (e: React.TouchEvent) => {
        // Only a single-finger press is a long-press; anything else (pinch,
        // second finger) cancels.
        if (e.touches.length !== 1) {
          clear();
          return;
        }
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY };
        didLongPress.current = false;
        timer.current = window.setTimeout(() => {
          timer.current = null;
          didLongPress.current = true;
          onLongPress(item);
        }, delay);
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!start.current) return;
        const t = e.touches[0];
        if (!t) return;
        if (
          Math.abs(t.clientX - start.current.x) > moveTolerance ||
          Math.abs(t.clientY - start.current.y) > moveTolerance
        ) {
          clear();
        }
      },
      onTouchEnd: (e: React.TouchEvent) => {
        if (didLongPress.current) {
          // Cancel the compatibility mouse events (click + mousedown) the
          // browser would fire on release.
          e.preventDefault();
        }
        clear();
      },
      onTouchCancel: () => clear(),
    }),
    [onLongPress, delay, moveTolerance, clear],
  );

  return { getHandlers, didLongPress };
}
