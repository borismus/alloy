import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceInputPress } from './useVoiceInputPress';

function pointerEvent() {
  return {
    button: 0,
    pointerId: 1,
    currentTarget: {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function setup(isActive = false) {
  const callbacks = {
    onStartAutomatic: vi.fn(),
    onStartPushToTalk: vi.fn(),
    onFinish: vi.fn(),
    onCancel: vi.fn(),
  };
  const hook = renderHook(
    ({ active }) => useVoiceInputPress({ isActive: active, ...callbacks }),
    { initialProps: { active: isActive } },
  );
  return { ...hook, callbacks };
}

describe('useVoiceInputPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses a short pointer press for automatic endpoint recording', () => {
    const { result, callbacks } = setup();
    const event = pointerEvent();

    act(() => result.current.onPointerDown(event));
    act(() => vi.advanceTimersByTime(449));
    expect(callbacks.onStartPushToTalk).not.toHaveBeenCalled();

    act(() => result.current.onPointerUp(event));
    expect(callbacks.onStartAutomatic).toHaveBeenCalledTimes(1);
    expect(callbacks.onFinish).not.toHaveBeenCalled();

    // React Aria also emits onPress for this pointer gesture; it must not start
    // a second recording session.
    act(() => result.current.onPress({ pointerType: 'mouse' }));
    expect(callbacks.onStartAutomatic).toHaveBeenCalledTimes(1);
  });

  it('starts push-to-talk after the hold threshold and finishes on release', () => {
    const { result, callbacks } = setup();
    const event = pointerEvent();

    act(() => result.current.onPointerDown(event));
    act(() => vi.advanceTimersByTime(450));
    expect(callbacks.onStartPushToTalk).toHaveBeenCalledTimes(1);
    expect(callbacks.onStartAutomatic).not.toHaveBeenCalled();

    act(() => result.current.onPointerUp(event));
    expect(callbacks.onFinish).toHaveBeenCalledTimes(1);
  });

  it('finishes an active automatic recording on the next press', () => {
    const { result, callbacks } = setup(true);
    const event = pointerEvent();

    act(() => result.current.onPointerDown(event));
    act(() => result.current.onPointerUp(event));

    expect(callbacks.onFinish).toHaveBeenCalledTimes(1);
    expect(callbacks.onStartAutomatic).not.toHaveBeenCalled();
    expect(callbacks.onStartPushToTalk).not.toHaveBeenCalled();
  });

  it('cancels rather than sends when a push-to-talk pointer is cancelled', () => {
    const { result, callbacks } = setup();
    const event = pointerEvent();

    act(() => result.current.onPointerDown(event));
    act(() => vi.advanceTimersByTime(450));
    act(() => result.current.onPointerCancel());

    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onFinish).not.toHaveBeenCalled();
  });

  it('uses accessible keyboard presses as automatic start/finish actions', () => {
    const { result, rerender, callbacks } = setup();

    act(() => result.current.onPress({ pointerType: 'keyboard' }));
    expect(callbacks.onStartAutomatic).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    act(() => result.current.onPress({ pointerType: 'virtual' }));
    expect(callbacks.onFinish).toHaveBeenCalledTimes(1);
  });
});
