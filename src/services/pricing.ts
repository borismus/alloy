interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

// Prefix-matched pricing table: first match wins.
// Dated model IDs (e.g. "claude-opus-4-5-20251101") match their base prefix.
// Order matters: more specific prefixes before less specific ones.
const PRICING_TABLE: [string, ModelPricing][] = [
  // Anthropic
  ['anthropic/claude-opus-4-7',       { inputPer1M: 5,     outputPer1M: 25 }],
  ['anthropic/claude-opus-4-6',       { inputPer1M: 5,     outputPer1M: 25 }],
  ['anthropic/claude-sonnet-4-6',     { inputPer1M: 3,     outputPer1M: 15 }],
  ['anthropic/claude-haiku-4-5',      { inputPer1M: 1,     outputPer1M: 5 }],
  // OpenAI (nano before mini before flagship for prefix ordering; gpt-5.5 before gpt-5.4)
  ['openai/gpt-5.4-nano',             { inputPer1M: 0.20,  outputPer1M: 1.25 }],
  ['openai/gpt-5.4-mini',             { inputPer1M: 0.75,  outputPer1M: 4.50 }],
  ['openai/gpt-5.5',                  { inputPer1M: 5,     outputPer1M: 30 }],
  ['openai/gpt-5.4',                  { inputPer1M: 2.50,  outputPer1M: 15 }],
  // Gemini (flash-lite before flash for prefix ordering)
  ['gemini/gemini-3.1-flash-lite',    { inputPer1M: 0.075, outputPer1M: 0.30 }],
  ['gemini/gemini-3.5-flash',         { inputPer1M: 1.50,  outputPer1M: 9.00 }],
  ['gemini/gemini-2.5-pro',           { inputPer1M: 1.25,  outputPer1M: 10 }],
  // Grok (grok-4.3 before grok-4.20)
  ['grok/grok-4.3',                   { inputPer1M: 1.25,  outputPer1M: 2.50 }],
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

// Anthropic ephemeral cache rates relative to base input price.
// Cache reads are billed at 10%, cache writes at 125% (5-min TTL).
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Estimate cost in USD for a given model and token counts.
 * Cached input tokens (Anthropic prompt caching) are billed at discounted rates.
 * Returns undefined for free models (Ollama) and unrecognized model strings.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheCreationInputTokens: number = 0,
): number | undefined {
  const pricing = findPricing(model);
  if (!pricing) return undefined;
  if (pricing.inputPer1M === 0 && pricing.outputPer1M === 0) return undefined;

  const inputCost =
    inputTokens * pricing.inputPer1M
    + cachedInputTokens * pricing.inputPer1M * CACHE_READ_MULTIPLIER
    + cacheCreationInputTokens * pricing.inputPer1M * CACHE_WRITE_MULTIPLIER;

  return (inputCost + outputTokens * pricing.outputPer1M) / 1_000_000;
}
