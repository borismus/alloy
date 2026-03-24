/**
 * Server-side cost estimation (mirrors src/services/pricing.ts).
 */

const PRICING_TABLE: [string, { inputPer1M: number; outputPer1M: number }][] = [
  ['anthropic/claude-opus-4-6',       { inputPer1M: 5,     outputPer1M: 25 }],
  ['anthropic/claude-sonnet-4-6',     { inputPer1M: 3,     outputPer1M: 15 }],
  ['anthropic/claude-haiku-4-5',      { inputPer1M: 1,     outputPer1M: 5 }],
  ['openai/gpt-5.4-nano',             { inputPer1M: 0.10,  outputPer1M: 0.40 }],
  ['openai/gpt-5.4-mini',             { inputPer1M: 0.25,  outputPer1M: 2 }],
  ['openai/gpt-5.4',                  { inputPer1M: 1.75,  outputPer1M: 14 }],
  ['gemini/gemini-3.1-pro',           { inputPer1M: 2,     outputPer1M: 12 }],
  ['gemini/gemini-2.5-flash-lite',    { inputPer1M: 0.075, outputPer1M: 0.30 }],
  ['gemini/gemini-2.5-flash',         { inputPer1M: 0.30,  outputPer1M: 2.50 }],
  ['grok/grok-4-1',                   { inputPer1M: 0.20,  outputPer1M: 0.50 }],
  ['grok/grok-4.20',                  { inputPer1M: 2,     outputPer1M: 6 }],
  ['ollama/',                         { inputPer1M: 0,     outputPer1M: 0 }],
];

export function estimateCostServer(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  for (const [prefix, pricing] of PRICING_TABLE) {
    if (model.startsWith(prefix)) {
      if (pricing.inputPer1M === 0 && pricing.outputPer1M === 0) return undefined;
      return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000;
    }
  }
  return undefined;
}
