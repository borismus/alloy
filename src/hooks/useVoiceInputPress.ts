import { useCallback, useEffect, useRef } from 'react';

interface UseVoiceInputPressOptions {
  isActive: boolean;
  onStartAutomatic: () => void;
  onStartPushToTalk: () => void;
  onFinish: () => void;
  onCancel: () => void;
  holdDelay?: number;
}

type PressIntent = 'pending' | 'push-to-talk' | 'finish';
type VoicePressEvent = { pointerType: 'mouse' | 'pen' | 'touch' | 'keyboard' | 'virtual' };

/**
 * Turns one microphone button into two explicit gestures:
 *
 * - a short press starts one-shot recording with automatic endpoint detection;
 * - holding past `holdDelay` starts push-to-talk, and release finishes it.
 *
 * Pointer events own mouse/touch/pen gestures so pointer cancellation can
 * cancel push-to-talk safely. React Aria's `onPress` remains the accessible
 * keyboard/virtual-click path and behaves like a short press.
 */
export function useVoiceInputPress({
  isActive,
  onStartAutomatic,
  onStartPushToTalk,
  onFinish,
  onCancel,
  holdDelay = 450,
}: UseVoiceInputPressOptions) {
  const holdTimerRef = useRef<number | null>(null);
  const intentRef = useRef<PressIntent | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearHoldTimer(), [clearHoldTimer]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || intentRef.current !== null) return;

    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (isActive) {
      intentRef.current = 'finish';
      return;
    }

    intentRef.current = 'pending';
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      if (intentRef.current !== 'pending') return;
      intentRef.current = 'push-to-talk';
      onStartPushToTalk();
    }, holdDelay);
  }, [holdDelay, isActive, onStartPushToTalk]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const intent = intentRef.current;
    if (!intent) return;

    clearHoldTimer();
    intentRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (intent === 'pending') {
      onStartAutomatic();
    } else {
      onFinish();
    }
  }, [clearHoldTimer, onFinish, onStartAutomatic]);

  const onPointerCancel = useCallback(() => {
    const intent = intentRef.current;
    clearHoldTimer();
    intentRef.current = null;
    if (intent === 'push-to-talk') {
      onCancel();
    }
  }, [clearHoldTimer, onCancel]);

  const onPress = useCallback((event: VoicePressEvent) => {
    // Mouse/touch/pen are handled by pointer events so hold duration is
    // available. React Aria's press event is only needed for keyboard and
    // assistive-technology virtual activation.
    if (event.pointerType !== 'keyboard' && event.pointerType !== 'virtual') return;
    if (isActive) {
      onFinish();
    } else {
      onStartAutomatic();
    }
  }, [isActive, onFinish, onStartAutomatic]);

  return { onPointerDown, onPointerUp, onPointerCancel, onPress };
}
