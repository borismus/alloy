import { describe, expect, it } from 'vitest';
import { levelFromSamples } from './useAudioLevel';

describe('levelFromSamples', () => {
  it('is zero for silence and for no samples', () => {
    expect(levelFromSamples(new Uint8Array(256).fill(128))).toBe(0);
    expect(levelFromSamples(new Uint8Array(0))).toBe(0);
  });

  // Amplitudes are out of 128. Laptop-mic speech is quiet in absolute terms.
  const wave = (amplitude: number) =>
    Uint8Array.from({ length: 256 }, (_, i) => 128 + Math.round(amplitude * Math.sin(i / 4)));

  it('keeps room noise near rest', () => {
    // Occasional one-step dither around silence: about -51 dBFS.
    const noise = Uint8Array.from({ length: 256 }, (_, i) => (i % 8 ? 128 : 129));
    expect(levelFromSamples(noise)).toBeLessThan(0.1);
  });

  it('puts ordinary laptop-mic speech well up the meter', () => {
    // ~-30 dBFS: the level that read as barely moving on a linear meter.
    const speech = levelFromSamples(wave(5));
    expect(speech).toBeGreaterThan(0.4);
    expect(speech).toBeLessThan(0.8);
  });

  it('grows with loudness and stays within 0..1', () => {
    const quiet = levelFromSamples(wave(2));
    const speech = levelFromSamples(wave(10));
    const shout = levelFromSamples(wave(127));
    expect(speech).toBeGreaterThan(quiet);
    expect(shout).toBeGreaterThan(speech);
    expect(shout).toBeLessThanOrEqual(1);
  });
});
