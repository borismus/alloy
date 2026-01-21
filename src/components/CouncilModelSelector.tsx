import { useState } from 'react';
import { ModelInfo, ProviderType } from '../types';
import './CouncilModelSelector.css';

interface CouncilModelSelectorProps {
  availableModels: ModelInfo[];
  onStartCouncil: (councilMembers: ModelInfo[], chairman: ModelInfo) => void;
  onCancel: () => void;
}

const PROVIDER_ORDER: ProviderType[] = ['anthropic', 'openai', 'gemini', 'ollama'];

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

export function CouncilModelSelector({
  availableModels,
  onStartCouncil,
  onCancel,
}: CouncilModelSelectorProps) {
  const [selectedMembers, setSelectedMembers] = useState<ModelInfo[]>([]);
  const [selectedChairman, setSelectedChairman] = useState<ModelInfo | null>(null);
  const maxMembers = 4;

  const modelsByProvider = PROVIDER_ORDER.reduce((acc, provider) => {
    const models = availableModels.filter(m => m.provider === provider);
    if (models.length > 0) {
      acc.set(provider, models);
    }
    return acc;
  }, new Map<ProviderType, ModelInfo[]>());

  const isMemberSelected = (model: ModelInfo) =>
    selectedMembers.some(m => m.id === model.id && m.provider === model.provider);

  const toggleMember = (model: ModelInfo) => {
    if (isMemberSelected(model)) {
      setSelectedMembers(selectedMembers.filter(
        m => !(m.id === model.id && m.provider === model.provider)
      ));
    } else if (selectedMembers.length < maxMembers) {
      setSelectedMembers([...selectedMembers, model]);
    }
  };

  const handleStart = () => {
    if (selectedMembers.length >= 2 && selectedChairman) {
      onStartCouncil(selectedMembers, selectedChairman);
    }
  };

  const canStart = selectedMembers.length >= 2 && selectedChairman !== null;

  return (
    <div className="council-model-selector">
      <div className="selector-header">
        <h2>Create a Council</h2>
        <p>Select 2-4 council members and a chairman to synthesize their responses</p>
      </div>

      <div className="council-sections">
        {/* Council Members Selection */}
        <div className="council-section">
          <div className="section-title">Council Members</div>
          <div className="models-list">
            {Array.from(modelsByProvider.entries()).map(([provider, models]) => (
              <div key={provider} className="provider-group">
                <div className="provider-name">{PROVIDER_NAMES[provider]}</div>
                <div className="provider-models">
                  {models.map((model) => (
                    <label
                      key={`member-${model.provider}-${model.id}`}
                      className={`model-option ${isMemberSelected(model) ? 'selected' : ''} ${
                        !isMemberSelected(model) && selectedMembers.length >= maxMembers ? 'disabled' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isMemberSelected(model)}
                        onChange={() => toggleMember(model)}
                        disabled={!isMemberSelected(model) && selectedMembers.length >= maxMembers}
                      />
                      <span className="model-name">{model.name}</span>
                      {provider === 'ollama' && <span className="local-badge">local</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="selection-count">
            {selectedMembers.length} of {maxMembers} members selected (min 2)
          </div>
        </div>

        {/* Chairman Selection */}
        <div className="council-section chairman-section">
          <div className="section-title">
            <span className="chairman-icon">👑</span>
            Chairman
          </div>
          <p className="chairman-description">
            The chairman will synthesize all council responses into a final answer
          </p>
          <select
            className="chairman-select"
            value={selectedChairman ? `${selectedChairman.provider}:${selectedChairman.id}` : ''}
            onChange={(e) => {
              if (e.target.value) {
                const [provider, ...idParts] = e.target.value.split(':');
                const modelId = idParts.join(':');
                const model = availableModels.find(
                  m => m.provider === provider && m.id === modelId
                );
                setSelectedChairman(model || null);
              } else {
                setSelectedChairman(null);
              }
            }}
          >
            <option value="">Select a chairman...</option>
            {Array.from(modelsByProvider.entries()).map(([provider, models]) => (
              <optgroup key={provider} label={PROVIDER_NAMES[provider]}>
                {models.map((model) => (
                  <option
                    key={`chairman-${model.provider}-${model.id}`}
                    value={`${model.provider}:${model.id}`}
                  >
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <div className="selector-footer">
        <div className="selection-summary">
          {selectedMembers.length} members
          {selectedChairman && ` + ${selectedChairman.name} as chairman`}
        </div>
        <div className="selector-actions">
          <button onClick={onCancel} className="cancel-button">
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="start-button"
            disabled={!canStart}
          >
            Start Council
          </button>
        </div>
      </div>
    </div>
  );
}
