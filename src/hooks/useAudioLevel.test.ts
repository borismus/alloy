import { describe, expect, it } from 'vitest';
import { levelFromSamples } from './useAudioLevel';

describe('levelFromSamples', () => {
  it('is zero for silence and for no samples', () => {
    expect(levelFromSamples(new Uint8Array(256).fill(128))).toBe(0);
    expect(levelFromSamples(new Uint8Array(0))).toBe(0);
  });

  it('grows with loudness and stays within 0..1', () => {
    const wave = (amplitude: number) =>
      Uint8Array.from({ length: 256 }, (_, i) => 128 + Math.round(amplitude * Math.sin(i / 4)));
    const quiet = levelFromSamples(wave(8));
    const speech = levelFromSamples(wave(40));
    const shout = levelFromSamples(wave(127));
    expect(quiet).toBeGreaterThan(0);
    expect(speech).toBeGreaterThan(quiet);
    expect(speech).toBeGreaterThan(0.5);
    expect(shout).toBeLessThanOrEqual(1);
  });
});
