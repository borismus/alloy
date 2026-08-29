export interface ModelPreferences {
  defaultModel: string;
  favoriteModels: string[];
}

function unique(keys: string[]): string[] {
  return [...new Set(keys.filter(Boolean))];
}

/** Toggle a non-default model's yellow favorite state. */
export function toggleFavoritePreference(
  current: ModelPreferences,
  modelKey: string,
): ModelPreferences {
  if (modelKey === current.defaultModel) return current;
  const favoriteModels = current.favoriteModels.includes(modelKey)
    ? current.favoriteModels.filter(key => key !== modelKey)
    : [...current.favoriteModels, modelKey];
  return { ...current, favoriteModels: unique(favoriteModels) };
}

/**
 * Assign the single red default. Defaults are also persisted as favorites so
 * assigning a new default demotes the previous one to a yellow favorite.
 */
export function setDefaultPreference(
  current: ModelPreferences,
  modelKey: string,
): ModelPreferences {
  if (!modelKey || modelKey === current.defaultModel) return current;
  return {
    defaultModel: modelKey,
    favoriteModels: unique([
      ...current.favoriteModels,
      current.defaultModel,
      modelKey,
    ]),
  };
}

/**
 * Advance a model's star: hollow → favorite (yellow) → default (red) → hollow.
 * Promoting a new default demotes the previous one to a yellow favorite;
 * removing the default also clears its favorite so the glyph returns to hollow
 * and the deterministic fallback order applies until a new default is chosen.
 */
export function cycleModelPreference(
  current: ModelPreferences,
  modelKey: string,
): ModelPreferences {
  if (modelKey === current.defaultModel) {
    return {
      defaultModel: '',
      favoriteModels: current.favoriteModels.filter(key => key !== modelKey),
    };
  }
  if (current.favoriteModels.includes(modelKey)) {
    return setDefaultPreference(current, modelKey);
  }
  return toggleFavoritePreference(current, modelKey);
}

/** Apply immediately, then restore the prior state if persistence fails. */
export async function persistModelPreferencesOptimistically(
  current: ModelPreferences,
  next: ModelPreferences,
  apply: (preferences: ModelPreferences) => void,
  persist: (preferences: ModelPreferences) => Promise<void>,
): Promise<void> {
  apply(next);
  try {
    await persist(next);
  } catch (error) {
    apply(current);
    throw error;
  }
}
