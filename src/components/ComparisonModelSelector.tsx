import { useState } from 'react';
import { ModelInfo, ProviderType, getProviderFromModel } from '../types';
import './ComparisonModelSelector.css';

interface ComparisonModelSelectorProps {
  availableModels: ModelInfo[];
  favoriteModels?: string[];  // Format: "provider/model-id"
  onStartComparison: (models: ModelInfo[]) => void;
  onCancel: () => void;
}

const PROVIDER_ORDER: ProviderType[] = ['anthropic', 'openai', 'gemini', 'ollama'];

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

export function ComparisonModelSelector({
  availableModels,
  favoriteModels = [],
  onStartComparison,
  onCancel,
}: ComparisonModelSelectorProps) {
  const [selectedModels, setSelectedModels] = useState<ModelInfo[]>([]);
  const maxModels = 3;

  // Check if a model is in the favorites list
  const isFavorite = (model: ModelInfo) => favoriteModels.includes(model.key);

  // Get favorite models (matched from available models)
  const favorites = availableModels.filter(isFavorite);

  // Group non-favorite models by provider
  const modelsByProvider = PROVIDER_ORDER.reduce((acc, provider) => {
    const models = availableModels.filter(m => getProviderFromModel(m.key) === provider && !isFavorite(m));
    if (models.length > 0) {
      acc.set(provider, models);
    }
    return acc;
  }, new Map<ProviderType, ModelInfo[]>());

  const isSelected = (model: ModelInfo) =>
    selectedModels.some(m => m.key === model.key);

  const toggleModel = (model: ModelInfo) => {
    if (isSelected(model)) {
      setSelectedModels(selectedModels.filter(m => m.key !== model.key));
    } else if (selectedModels.length < maxModels) {
      setSelectedModels([...selectedModels, model]);
    }
  };

  const handleStart = () => {
    if (selectedModels.length >= 2) {
      onStartComparison(selectedModels);
    }
  };

  return (
    <div className="comparison-model-selector">
      <div className="selector-header">
        <h2>Select Models to Compare</h2>
        <p>Choose 2-3 models to compare side by side</p>
      </div>

      <div className="models-list">
        {favorites.length > 0 && (
          <div className="provider-group favorites">
            <div className="provider-name">Favorites</div>
            <div className="provider-models">
              {favorites.map((model) => (
                <label
                  key={model.key}
                  className={`model-option ${isSelected(model) ? 'selected' : ''} ${
                    !isSelected(model) && selectedModels.length >= maxModels ? 'disabled' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected(model)}
                    onChange={() => toggleModel(model)}
                    disabled={!isSelected(model) && selectedModels.length >= maxModels}
                  />
                  <span className="model-name">{model.name}</span>
                  {getProviderFromModel(model.key) === 'ollama' && <span className="local-badge">local</span>}
                </label>
              ))}
            </div>
          </div>
        )}
        {Array.from(modelsByProvider.entries()).map(([provider, models]) => (
          <div key={provider} className="provider-group">
            <div className="provider-name">{PROVIDER_NAMES[provider]}</div>
            <div className="provider-models">
              {models.map((model) => (
                <label
                  key={model.key}
                  className={`model-option ${isSelected(model) ? 'selected' : ''} ${
                    !isSelected(model) && selectedModels.length >= maxModels ? 'disabled' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected(model)}
                    onChange={() => toggleModel(model)}
                    disabled={!isSelected(model) && selectedModels.length >= maxModels}
                  />
                  <span className="model-name">{model.name}</span>
                  {provider === 'ollama' && <span className="local-badge">local</span>}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="selector-footer">
        <div className="selection-count">
          {selectedModels.length} of {maxModels} selected
        </div>
        <div className="selector-actions">
          <button onClick={onCancel} className="cancel-button">
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="start-button"
            disabled={selectedModels.length < 2}
          >
            Start Comparison
          </button>
        </div>
      </div>
    </div>
  );
}
