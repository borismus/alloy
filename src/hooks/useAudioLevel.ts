import { RefObject, useEffect } from 'react';

/**
 * Loudness of one analyser frame, 0..1, from 8-bit time-domain samples
 * (128 = silence). RMS, boosted so ordinary speech reaches the upper half of
 * the meter, and clamped.
 */
export function levelFromSamples(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const v = (s - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, rms * 4);
}

/**
 * Drive a CSS variable (`--level`, 0..1) on `targetRef` from a live
 * microphone stream, once per animation frame, without re-rendering React.
 * Silently does nothing when there's no stream or the browser can't analyse
 * it (e.g. a mocked stream in tests): the meter then sits at rest.
 */
export function useAudioLevel(stream: MediaStream | null | undefined, targetRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const target = targetRef.current;
    if (!stream || !target) return;
    const AudioContextClass = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    let context: AudioContext | null = null;
    let frame = 0;
    try {
      context = new AudioContextClass();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      void context.resume().catch(() => {});
      const samples = new Uint8Array(analyser.fftSize);
      let smoothed = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        // Rise fast, fall slowly, so the meter reads as speech, not jitter.
        const level = levelFromSamples(samples);
        smoothed = level > smoothed ? level : smoothed * 0.85 + level * 0.15;
        target.style.setProperty('--level', smoothed.toFixed(3));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch {
      void context?.close().catch(() => {});
      return;
    }

    return () => {
      cancelAnimationFrame(frame);
      target.style.removeProperty('--level');
      void context?.close().catch(() => {});
    };
  }, [stream, targetRef]);
}
