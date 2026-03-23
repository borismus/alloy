interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

// Prefix-matched pricing table: first match wins.
// Dated model IDs (e.g. "claude-opus-4-5-20251101") match their base prefix.
// Order matters: more specific prefixes before less specific ones.
const PRICING_TABLE: [string, ModelPricing][] = [
  // Anthropic
  ['anthropic/claude-opus-4-6',       { inputPer1M: 5,     outputPer1M: 25 }],
  ['anthropic/claude-sonnet-4-6',     { inputPer1M: 3,     outputPer1M: 15 }],
  ['anthropic/claude-haiku-4-5',      { inputPer1M: 1,     outputPer1M: 5 }],
  // OpenAI (gpt-5.4-nano before gpt-5.4-mini before gpt-5.4 for prefix ordering)
  ['openai/gpt-5.4-nano',             { inputPer1M: 0.10,  outputPer1M: 0.40 }],
  ['openai/gpt-5.4-mini',             { inputPer1M: 0.25,  outputPer1M: 2 }],
  ['openai/gpt-5.4',                  { inputPer1M: 1.75,  outputPer1M: 14 }],
  // Gemini (flash-lite before flash for prefix ordering)
  ['gemini/gemini-3.1-pro',           { inputPer1M: 2,     outputPer1M: 12 }],
  ['gemini/gemini-2.5-flash-lite',    { inputPer1M: 0.075, outputPer1M: 0.30 }],
  ['gemini/gemini-2.5-flash',         { inputPer1M: 0.30,  outputPer1M: 2.50 }],
  // Grok (grok-4-1 before grok-4.20 for prefix ordering)
  ['grok/grok-4-1',                   { inputPer1M: 0.20,  outputPer1M: 0.50 }],
  ['grok/grok-4.20',                  { inputPer1M: 2,     outputPer1M: 6 }],
  // Ollama - local, free
  ['ollama/',                         { inputPer1M: 0,     outputPer1M: 0 }],
];

function findPricing(model: string): ModelPricing | undefined {
  for (const [prefix, pricing] of PRICING_TABLE) {
    if (model.startsWith(prefix)) {
      return pricing;
    }
  }
  return undefined;
}

/**
 * Estimate cost in USD for a given model and token counts.
 * Returns undefined for free models (Ollama) and unrecognized model strings.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const pricing = findPricing(model);
  if (!pricing) return undefined;
  if (pricing.inputPer1M === 0 && pricing.outputPer1M === 0) return undefined;
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000;
}
