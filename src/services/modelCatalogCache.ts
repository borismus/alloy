import type { ModelInfo } from '../types';

const KEY_PREFIX = 'alloy.modelCatalog.v1:';

function storageKey(vaultPath: string): string {
  return `${KEY_PREFIX}${vaultPath}`;
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<ModelInfo>;
  return typeof model.key === 'string'
    && model.key.length > 0
    && typeof model.name === 'string'
    && model.name.length > 0
    && (model.provider === undefined || typeof model.provider === 'string')
    && (model.local === undefined || typeof model.local === 'boolean')
    && (model.contextWindow === undefined || typeof model.contextWindow === 'number')
    && (model.supportsImages === undefined || typeof model.supportsImages === 'boolean');
}

/**
 * Return the last successful catalog for this exact vault. Model metadata is
 * safe to keep locally and lets the picker render immediately while the server
 * refreshes remote endpoints and subscription CLIs in the background.
 */
export function loadCachedModelCatalog(vaultPath: string): ModelInfo[] {
  try {
    const stored = localStorage.getItem(storageKey(vaultPath));
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isModelInfo)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveCachedModelCatalog(vaultPath: string, models: ModelInfo[]): void {
  if (models.length === 0) return;
  try {
    localStorage.setItem(storageKey(vaultPath), JSON.stringify(models));
  } catch {
    // Storage may be unavailable or full; discovery still works without cache.
  }
}
