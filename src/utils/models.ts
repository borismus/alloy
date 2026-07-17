import { ProviderType } from '../types';

export const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
  grok: 'Grok',
  openrouter: 'OpenRouter',
  'claude-cli': 'Claude (subscription)',
  mlx: 'oMLX',
};

/**
 * Short uppercase tag shown as a chip in the model picker (e.g. "OR", "MLX",
 * "ANT"). Compact provenance that doesn't crowd the model name; the full
 * provider name lives in the chip's tooltip via {@link providerLabel}.
 */
export const PROVIDER_TAGS: Record<ProviderType, string> = {
  anthropic: 'ANT',
  openai: 'OAI',
  ollama: 'OLL',
  gemini: 'GEM',
  grok: 'GROK',
  openrouter: 'OR',
  'claude-cli': 'ANT',
  mlx: 'MLX',
};

/**
 * Human-readable provider label for a model. Prefers the backend-supplied
 * provider id, falling back to the model key's prefix. Unknown ids (arbitrary
 * `providers:` entries in config.yaml) are prettified rather than dropped, so
 * the picker never shows a blank provider.
 */
export function providerLabel(providerId: string | undefined, modelKey: string): string {
  const id = providerId || modelKey.split('/')[0] || '';
  return (
    PROVIDER_NAMES[id as ProviderType] ||
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}

/**
 * Short provider tag for the picker chip. Known providers use a curated tag;
 * unknown ids fall back to their first three characters uppercased.
 */
export function providerTag(providerId: string | undefined, modelKey: string): string {
  const id = providerId || modelKey.split('/')[0] || '';
  return PROVIDER_TAGS[id as ProviderType] || id.slice(0, 3).toUpperCase();
}

