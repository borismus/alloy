import { ProviderType, ModelInfo } from '../types';

export const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  grok: 'Grok',
  openrouter: 'OpenRouter',
  'claude-cli': 'Anthropic Claude (subscription)',
  'codex-cli': 'OpenAI Codex (subscription)',
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
  gemini: 'GEM',
  grok: 'GROK',
  openrouter: 'OR',
  'claude-cli': 'ANT',
  'codex-cli': 'OAI',
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
  const known = PROVIDER_NAMES[id as ProviderType];
  if (known) return known;
  // User-defined oMLX endpoints (`mlx-local`, `omlx-m4`, …) should read — and
  // therefore SEARCH — as oMLX rather than as a prettified raw id.
  if (id.toLowerCase().includes('mlx')) return `oMLX (${id})`;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Short provider tag for the picker chip. Known providers use a curated tag;
 * unknown ids fall back to their first three characters uppercased.
 */
export function providerTag(providerId: string | undefined, modelKey: string): string {
  const id = providerId || modelKey.split('/')[0] || '';
  return PROVIDER_TAGS[id as ProviderType] || id.slice(0, 3).toUpperCase();
}

/**
 * Whether a model runs locally (on-device / trusted hardware), for the privacy
 * badge. Locality comes from the backend's endpoint classification rather than
 * the provider name, so a compatible endpoint on a routable host is not
 * accidentally trusted with private data.
 */
export function isLocalModel(modelKey: string, availableModels: ModelInfo[]): boolean {
  return availableModels.some(m => m.key === modelKey && m.local);
}

/**
 * Choose the model for a newly created resource. While discovery is still in
 * flight, trust config.yaml; once the catalog is available, only return a key
 * the picker can render.
 */
export function chooseDefaultModel(
  configuredDefault: string | undefined,
  favoriteModels: string[] | undefined,
  availableModels: ModelInfo[],
): string | null {
  if (availableModels.length === 0) {
    // Discovery is asynchronous. Honor the configured default before the live
    // catalog arrives; if it is blank, preserve config order as the fallback.
    return configuredDefault || favoriteModels?.[0] || null;
  }

  const validKeys = new Set(availableModels.map(model => model.key));
  if (configuredDefault && validKeys.has(configuredDefault)) {
    return configuredDefault;
  }

  // A stale/offline default cannot be rendered by the picker. Fall back in a
  // stable order: first reachable configured favorite, then catalog order.
  return (favoriteModels ?? []).find(key => validKeys.has(key))
    ?? availableModels[0]?.key
    ?? null;
}

