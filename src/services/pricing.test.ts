import { describe, it, expect } from 'vitest';
import { estimateCost } from './pricing';

describe('estimateCost', () => {
  describe('Anthropic models', () => {
    it('calculates cost for Claude Opus', () => {
      // $5/M input, $25/M output
      const cost = estimateCost('anthropic/claude-opus-4-6', 1_000_000, 1_000_000);
      expect(cost).toBe(30); // 5 + 25
    });

    it('calculates cost for Claude Sonnet', () => {
      // $3/M input, $15/M output
      const cost = estimateCost('anthropic/claude-sonnet-4-6', 1000, 500);
      expect(cost).toBeCloseTo(0.003 + 0.0075);
    });

    it('calculates cost for Claude Haiku', () => {
      // $1/M input, $5/M output
      const cost = estimateCost('anthropic/claude-haiku-4-5', 100_000, 50_000);
      expect(cost).toBeCloseTo(0.1 + 0.25);
    });
  });

  describe('prefix matching', () => {
    it('matches dated model IDs via prefix', () => {
      // 'anthropic/claude-opus-4-6-20251101' starts with 'anthropic/claude-opus-4-6'
      const cost = estimateCost('anthropic/claude-opus-4-6-20260101', 1_000_000, 0);
      expect(cost).toBe(5);
    });

    it('matches gpt-5.4-nano before gpt-5.4', () => {
      const nanoCost = estimateCost('openai/gpt-5.4-nano', 1_000_000, 1_000_000);
      expect(nanoCost).toBeCloseTo(0.50); // 0.10 + 0.40

      const baseCost = estimateCost('openai/gpt-5.4', 1_000_000, 1_000_000);
      expect(baseCost).toBeCloseTo(15.75); // 1.75 + 14
    });

    it('matches gpt-5.4-mini before gpt-5.4', () => {
      const miniCost = estimateCost('openai/gpt-5.4-mini', 1_000_000, 1_000_000);
      expect(miniCost).toBeCloseTo(2.25); // 0.25 + 2
    });

    it('matches gemini flash-lite before flash', () => {
      const liteCost = estimateCost('gemini/gemini-2.5-flash-lite', 1_000_000, 1_000_000);
      expect(liteCost).toBeCloseTo(0.375); // 0.075 + 0.30

      const flashCost = estimateCost('gemini/gemini-2.5-flash', 1_000_000, 1_000_000);
      expect(flashCost).toBeCloseTo(2.80); // 0.30 + 2.50
    });
  });

  describe('Grok models', () => {
    it('calculates cost for grok-4-1', () => {
      const cost = estimateCost('grok/grok-4-1', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(0.70); // 0.20 + 0.50
    });

    it('calculates cost for grok-4.20', () => {
      const cost = estimateCost('grok/grok-4.20', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(8); // 2 + 6
    });
  });

  describe('Ollama (free)', () => {
    it('returns undefined for ollama models', () => {
      expect(estimateCost('ollama/llama3', 1_000_000, 1_000_000)).toBeUndefined();
    });

    it('returns undefined for any ollama model name', () => {
      expect(estimateCost('ollama/mistral:latest', 500, 500)).toBeUndefined();
    });
  });

  describe('prompt caching (Anthropic)', () => {
    it('bills cache_read tokens at 10% of input rate', () => {
      // Sonnet input is $3/M, so 1M cache reads = $0.30
      const cost = estimateCost('anthropic/claude-sonnet-4-6', 0, 0, 1_000_000, 0);
      expect(cost).toBeCloseTo(0.30);
    });

    it('bills cache_creation tokens at 125% of input rate', () => {
      // Sonnet input is $3/M, so 1M cache writes = $3.75
      const cost = estimateCost('anthropic/claude-sonnet-4-6', 0, 0, 0, 1_000_000);
      expect(cost).toBeCloseTo(3.75);
    });

    it('combines uncached, cached-read, cached-write, and output costs', () => {
      // Opus: $5/M input, $25/M output
      // 100K uncached input + 50K cache write + 200K cache read + 10K output
      // = 100K*5 + 50K*5*1.25 + 200K*5*0.1 + 10K*25  (per 1M)
      // = 0.5 + 0.3125 + 0.1 + 0.25 = 1.1625
      const cost = estimateCost(
        'anthropic/claude-opus-4-6',
        100_000,
        10_000,
        200_000,
        50_000,
      );
      expect(cost).toBeCloseTo(1.1625);
    });

    it('treats omitted cache args as zero', () => {
      const a = estimateCost('anthropic/claude-sonnet-4-6', 1000, 500);
      const b = estimateCost('anthropic/claude-sonnet-4-6', 1000, 500, 0, 0);
      expect(a).toBe(b);
    });
  });

  describe('edge cases', () => {
    it('returns undefined for unknown model', () => {
      expect(estimateCost('unknown/model-x', 1000, 1000)).toBeUndefined();
    });

    it('returns 0 for zero tokens on paid model', () => {
      const cost = estimateCost('anthropic/claude-sonnet-4-6', 0, 0);
      expect(cost).toBe(0);
    });

    it('handles input-only cost', () => {
      const cost = estimateCost('anthropic/claude-opus-4-6', 1_000_000, 0);
      expect(cost).toBe(5);
    });

    it('handles output-only cost', () => {
      const cost = estimateCost('anthropic/claude-opus-4-6', 0, 1_000_000);
      expect(cost).toBe(25);
    });
  });
});
