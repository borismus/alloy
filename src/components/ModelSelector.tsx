import { useState, useRef, useEffect } from 'react';
import { ModelInfo, ProviderType } from '../types';
import './ModelSelector.css';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string, provider: ProviderType) => void;
  disabled: boolean;
  models: ModelInfo[];
}

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
};

export function ModelSelector({ value, onChange, disabled, models }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<'below' | 'above'>('below');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selectedModel = models.find(m => m.id === value);

  // Group models by provider
  const groupedModels = models.reduce((acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  }, {} as Record<ProviderType, ModelInfo[]>);

  const providerOrder: ProviderType[] = ['anthropic', 'openai', 'ollama'];
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
      const itemCount = models.length + sortedProviders.length; // models + group headers
      const dropdownHeight = itemCount * 40 + 16;
      const spaceBelow = window.innerHeight - buttonRect.bottom;
      const spaceAbove = buttonRect.top;

      if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
        setDropdownPosition('above');
      } else {
        setDropdownPosition('below');
      }
    }
  }, [isOpen, models.length, sortedProviders.length]);

  const handleSelect = (model: ModelInfo) => {
    onChange(model.id, model.provider);
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
        <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {isOpen && (
        <div className={`model-selector-dropdown ${dropdownPosition}`}>
          {sortedProviders.map((provider) => (
            <div key={provider} className="model-group">
              <div className="model-group-header">
                {PROVIDER_NAMES[provider]}
                {provider === 'ollama' && <span className="provider-badge">local</span>}
              </div>
              {groupedModels[provider].map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={`model-option ${model.id === value ? 'selected' : ''}`}
                  onClick={() => handleSelect(model)}
                >
                  {model.name}
                  {model.id === value && (
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
