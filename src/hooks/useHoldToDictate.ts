import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

interface UseHoldToDictateOptions {
  enabled: boolean;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
  holdDelay?: number;
}

function isSpace(event: Pick<KeyboardEvent, 'code' | 'key'>): boolean {
  return event.code === 'Space' || event.key === ' ';
}

/**
 * Treat a held Space key as push-to-talk without making ordinary spaces lag.
 * The browser inserts the initial space normally; the caller snapshots and
 * restores its input if the hold threshold is crossed. Key release is observed
 * on window because starting dictation disables (and blurs) the textarea.
 */
export function useHoldToDictate({
  enabled,
  onStart,
  onFinish,
  onCancel,
  holdDelay = 450,
}: UseHoldToDictateOptions) {
  const timerRef = useRef<number | null>(null);
  const pressedRef = useRef(false);
  const holdingRef = useRef(false);
  const callbacksRef = useRef({ onStart, onFinish, onCancel });

  useEffect(() => {
    callbacksRef.current = { onStart, onFinish, onCancel };
  }, [onStart, onFinish, onCancel]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    pressedRef.current = false;
    holdingRef.current = false;
  }, [clearTimer]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (pressedRef.current && event.repeat && isSpace(event)) {
        event.preventDefault();
      }
    };

    const handleWindowKeyUp = (event: KeyboardEvent) => {
      if (!pressedRef.current || !isSpace(event)) return;
      event.preventDefault();
      const wasHolding = holdingRef.current;
      reset();
      if (wasHolding) callbacksRef.current.onFinish();
    };

    const handleWindowBlur = () => {
      if (!pressedRef.current) return;
      const wasHolding = holdingRef.current;
      reset();
      if (wasHolding) callbacksRef.current.onCancel();
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    window.addEventListener('keyup', handleWindowKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      window.removeEventListener('keyup', handleWindowKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      if (holdingRef.current) callbacksRef.current.onCancel();
      reset();
    };
  }, [reset]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSpace(event)) return;

    // Once the key is owned by a pending/active hold, suppress OS key repeat so
    // it cannot add spaces or scroll the page after the textarea is disabled.
    if (pressedRef.current) {
      if (event.repeat) event.preventDefault();
      return;
    }

    if (
      !enabled
      || event.repeat
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || event.nativeEvent.isComposing
    ) return;

    pressedRef.current = true;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!pressedRef.current) return;
      holdingRef.current = true;
      callbacksRef.current.onStart();
    }, holdDelay);
  }, [enabled, holdDelay]);

  return { onKeyDown };
}
