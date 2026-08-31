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

/** Assign the default without changing any model's independent favorite state. */
export function setDefaultPreference(
  current: ModelPreferences,
  modelKey: string,
): ModelPreferences {
  if (!modelKey || modelKey === current.defaultModel) return current;
  return { ...current, defaultModel: modelKey };
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
