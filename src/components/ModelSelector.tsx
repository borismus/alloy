import { useState, useRef, useEffect } from 'react';
import { ModelInfo, ProviderType, getProviderFromModel } from '../types';
import './ModelSelector.css';

interface ModelSelectorProps {
  value: string;  // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  onChange: (modelKey: string) => void;  // Now takes the unified key
  disabled: boolean;
  models: ModelInfo[];
  favoriteModels?: string[];  // Format: "provider/model-id"
}

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

export function ModelSelector({ value, onChange, disabled, models, favoriteModels = [] }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<'below' | 'above'>('below');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // value is now in "provider/model-id" format, same as model.key
  const selectedModel = models.find(m => m.key === value);

  // Check if a model is in the favorites list
  const isFavorite = (model: ModelInfo) => favoriteModels.includes(model.key);

  // Get favorite models (matched from available models)
  const favorites = models.filter(isFavorite);

  // Group non-favorite models by provider (extract provider from model.key)
  const groupedModels = models
    .filter(m => !isFavorite(m))
    .reduce((acc, model) => {
      const provider = getProviderFromModel(model.key);
      if (!acc[provider]) {
        acc[provider] = [];
      }
      acc[provider].push(model);
      return acc;
    }, {} as Record<ProviderType, ModelInfo[]>);

  const providerOrder: ProviderType[] = ['anthropic', 'openai', 'gemini', 'grok', 'ollama'];
  const sortedProviders = providerOrder.filter(p => groupedModels[p]?.length > 0);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      const favoritesHeader = favorites.length > 0 ? 1 : 0;
      const itemCount = models.length + sortedProviders.length + favoritesHeader;
      const dropdownHeight = itemCount * 40 + 16;
      const spaceBelow = window.innerHeight - buttonRect.bottom;
      const spaceAbove = buttonRect.top;

      if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
        setDropdownPosition('above');
      } else {
        setDropdownPosition('below');
      }
    }
  }, [isOpen, models.length, sortedProviders.length, favorites.length]);

  const handleSelect = (model: ModelInfo) => {
    onChange(model.key);
    setIsOpen(false);
  };

  return (
    <div className="model-selector-container" ref={dropdownRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`model-selector-button ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <span>{selectedModel?.name || 'Select Model'}</span>
        <svg className={`chevron ${isOpen ? 'open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {isOpen && (
        <div className={`model-selector-dropdown ${dropdownPosition}`}>
          {favorites.length > 0 && (
            <div className="model-group favorites">
              <div className="model-group-header">Favorites</div>
              {favorites.map((model) => (
                <button
                  key={model.key}
                  type="button"
                  className={`model-option ${model.key === value ? 'selected' : ''}`}
                  onClick={() => handleSelect(model)}
                >
                  {model.name}
                  {model.key === value && (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
          {sortedProviders.map((provider) => (
            <div key={provider} className="model-group">
              <div className="model-group-header">
                {PROVIDER_NAMES[provider]}
                {provider === 'ollama' && <span className="provider-badge">local</span>}
              </div>
              {groupedModels[provider].map((model) => (
                <button
                  key={model.key}
                  type="button"
                  className={`model-option ${model.key === value ? 'selected' : ''}`}
                  onClick={() => handleSelect(model)}
                >
                  {model.name}
                  {model.key === value && (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
