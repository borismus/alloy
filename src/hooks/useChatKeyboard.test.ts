import { renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatKeyboard } from './useChatKeyboard';

afterEach(() => vi.restoreAllMocks());

function press(touch: boolean, init: { shiftKey?: boolean; isComposing?: boolean } = {}) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: touch }) as unknown as typeof window.matchMedia;
  const onSubmit = vi.fn();
  const { result } = renderHook(() => useChatKeyboard({ onSubmit }));
  const preventDefault = vi.fn();
  result.current({
    key: 'Enter',
    shiftKey: init.shiftKey ?? false,
    altKey: false,
    preventDefault,
    nativeEvent: { isComposing: init.isComposing ?? false },
  } as unknown as KeyboardEvent<HTMLTextAreaElement>);
  return { onSubmit, preventDefault };
}

it('sends on Enter with a mouse or trackpad', () => {
  const { onSubmit, preventDefault } = press(false);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(preventDefault).toHaveBeenCalled();
});

it('lets Enter insert a line break on a touchscreen', () => {
  const { onSubmit, preventDefault } = press(true);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(preventDefault).not.toHaveBeenCalled();
});

it('keeps Shift+Enter as a line break on desktop', () => {
  expect(press(false, { shiftKey: true }).onSubmit).not.toHaveBeenCalled();
});

it('does not send while text is still being composed', () => {
  expect(press(false, { isComposing: true }).onSubmit).not.toHaveBeenCalled();
});
