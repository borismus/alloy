import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLongPress } from './useLongPress';

// Minimal React.TouchEvent stand-in for the handlers under test.
function touchEvent(points: Array<{ x: number; y: number }>) {
  return {
    touches: points.map((p) => ({ clientX: p.x, clientY: p.y })),
    preventDefault: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires with the bound item after the delay', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500 }));
    const h = result.current.getHandlers('item-1');

    h.onTouchStart(touchEvent([{ x: 10, y: 10 }]));
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledWith('item-1');
    expect(result.current.didLongPress.current).toBe(true);
  });

  it('cancels when the finger moves beyond the tolerance (a scroll)', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500, moveTolerance: 10 }));
    const h = result.current.getHandlers('x');

    h.onTouchStart(touchEvent([{ x: 10, y: 10 }]));
    h.onTouchMove(touchEvent([{ x: 10, y: 40 }]));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when the touch ends before the delay', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500 }));
    const h = result.current.getHandlers('x');

    h.onTouchStart(touchEvent([{ x: 10, y: 10 }]));
    vi.advanceTimersByTime(200);
    h.onTouchEnd(touchEvent([{ x: 10, y: 10 }]));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does not fire for a multi-finger touch', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500 }));
    const h = result.current.getHandlers('x');

    h.onTouchStart(touchEvent([{ x: 1, y: 1 }, { x: 2, y: 2 }]));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('suppresses the synthesized click on release after firing', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500 }));
    const h = result.current.getHandlers('x');

    h.onTouchStart(touchEvent([{ x: 10, y: 10 }]));
    vi.advanceTimersByTime(500);
    const end = touchEvent([{ x: 10, y: 10 }]);
    h.onTouchEnd(end);
    expect(end.preventDefault).toHaveBeenCalled();
  });
});
