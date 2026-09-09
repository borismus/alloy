import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHoldToDictate } from './useHoldToDictate';

function spaceEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: ' ',
    code: 'Space',
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function releaseSpace() {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space' }));
}

describe('useHoldToDictate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(enabled = true) {
    const callbacks = {
      onStart: vi.fn(),
      onFinish: vi.fn(),
      onCancel: vi.fn(),
    };
    const hook = renderHook(() => useHoldToDictate({ enabled, ...callbacks }));
    return { ...hook, callbacks };
  }

  it('leaves an ordinary short Space press alone', () => {
    const { result, callbacks } = setup();
    const event = spaceEvent();

    act(() => result.current.onKeyDown(event));
    act(() => vi.advanceTimersByTime(449));
    act(releaseSpace);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callbacks.onStart).not.toHaveBeenCalled();
    expect(callbacks.onFinish).not.toHaveBeenCalled();
  });

  it('starts after the hold threshold and finishes on window keyup', () => {
    const { result, callbacks } = setup();

    act(() => result.current.onKeyDown(spaceEvent()));
    act(() => vi.advanceTimersByTime(450));
    expect(callbacks.onStart).toHaveBeenCalledTimes(1);

    act(releaseSpace);
    expect(callbacks.onFinish).toHaveBeenCalledTimes(1);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it('suppresses repeated spaces while a hold is pending', () => {
    const { result } = setup();
    act(() => result.current.onKeyDown(spaceEvent()));

    const repeated = spaceEvent({ repeat: true });
    act(() => result.current.onKeyDown(repeated));

    expect(repeated.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('cancels active push-to-talk if the window loses focus', () => {
    const { result, callbacks } = setup();
    act(() => result.current.onKeyDown(spaceEvent()));
    act(() => vi.advanceTimersByTime(450));
    act(() => window.dispatchEvent(new Event('blur')));

    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onFinish).not.toHaveBeenCalled();
  });

  it('ignores modified, composing, and disabled Space presses', () => {
    const { result, callbacks } = setup(false);
    act(() => result.current.onKeyDown(spaceEvent()));
    act(() => vi.advanceTimersByTime(450));
    expect(callbacks.onStart).not.toHaveBeenCalled();

    const enabled = renderHook(() => useHoldToDictate({
      enabled: true,
      onStart: callbacks.onStart,
      onFinish: callbacks.onFinish,
      onCancel: callbacks.onCancel,
    }));
    act(() => enabled.result.current.onKeyDown(spaceEvent({ metaKey: true })));
    act(() => enabled.result.current.onKeyDown(spaceEvent({ nativeEvent: { isComposing: true } })));
    act(() => vi.advanceTimersByTime(450));
    expect(callbacks.onStart).not.toHaveBeenCalled();
  });
});
