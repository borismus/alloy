import React, { useState } from 'react';
import { Conversation, TriggerConfig, ModelInfo } from '../types';
import './TriggerConfigModal.css';

interface TriggerConfigModalProps {
  conversation?: Conversation | null;  // null for new trigger, existing for edit
  availableModels: ModelInfo[];
  favoriteModels?: string[];  // Format: "provider/model-id"
  onSave: (config: TriggerConfig, title?: string) => void;
  onClose: () => void;
}

const INTERVAL_OPTIONS = [
  { value: 1, label: '1 minute (testing)' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 360, label: '6 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '24 hours' },
];

export function TriggerConfigModal({
  conversation,
  availableModels,
  favoriteModels = [],
  onSave,
  onClose,
}: TriggerConfigModalProps) {
  const existingTrigger = conversation?.trigger;
  const isEditing = !!existingTrigger;

  // Default trigger model (prefer haiku for cost efficiency)
  const defaultTriggerModel = availableModels.find(m => m.key.includes('haiku'))?.key
    || availableModels[0]?.key
    || 'anthropic/claude-haiku-4-5-20251001';

  // Default main model
  // conversation.model is already in "provider/model-id" format
  const defaultMainModel = conversation?.model
    || availableModels[0]?.key
    || 'anthropic/claude-sonnet-4-5-20250929';

  // Form state
  const [title, setTitle] = useState(conversation?.title || '');
  const [triggerPrompt, setTriggerPrompt] = useState(existingTrigger?.triggerPrompt || '');
  const [triggerModel, setTriggerModel] = useState(
    existingTrigger?.triggerModel || defaultTriggerModel
  );
  const [mainPrompt, setMainPrompt] = useState(existingTrigger?.mainPrompt || '');
  const [mainModel, setMainModel] = useState(
    existingTrigger?.mainModel || defaultMainModel
  );
  const [intervalMinutes, setIntervalMinutes] = useState(
    existingTrigger?.intervalMinutes || 60
  );
  const [enabled, setEnabled] = useState(existingTrigger?.enabled ?? true);

  // Check if a model is in the favorites list
  const isFavorite = (model: ModelInfo) =>
    favoriteModels.includes(model.key);

  // Get favorite models (matched from available models)
  const favorites = availableModels.filter(isFavorite);

  // Get non-favorite models
  const nonFavorites = availableModels.filter(m => !isFavorite(m));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const config: TriggerConfig = {
      enabled,
      triggerPrompt,
      triggerModel,
      mainPrompt,
      mainModel,
      intervalMinutes,
      lastChecked: existingTrigger?.lastChecked,
      lastTriggered: existingTrigger?.lastTriggered,
    };

    onSave(config, isEditing ? undefined : title);
  };

  const isValid = triggerPrompt.trim() && mainPrompt.trim() && (isEditing || title.trim());

  const renderModelSelect = (
    id: string,
    value: string,
    onChange: (value: string) => void,
    hint: string
  ) => (
    <div className="form-group">
      <label htmlFor={id}>{id === 'triggerModel' ? 'Trigger Model' : 'Main Model'}</label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        {favorites.length > 0 && (
          <optgroup label="Favorites">
            {favorites.map(m => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
        {nonFavorites.map(m => (
          <option key={m.key} value={m.key}>
            {m.name}
          </option>
        ))}
      </select>
      <span className="form-hint">{hint}</span>
    </div>
  );

  return (
    <div className="trigger-config-modal-overlay" onClick={onClose}>
      <div className="trigger-config-modal" onClick={e => e.stopPropagation()}>
        <div className="trigger-config-header">
          <h2>{isEditing ? 'Edit Trigger' : 'Create Triggered Conversation'}</h2>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          {!isEditing && (
            <div className="form-group">
              <label htmlFor="title">Conversation Title</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g., Daily News Summary"
              />
            </div>
          )}

          <div className="form-section">
            <h3>Trigger Condition</h3>
            <p className="form-hint">
              This prompt runs on a schedule. It must determine whether to trigger the main prompt.
              The response must be JSON: {`{"shouldTrigger": true/false, "reasoning": "..."}`}
            </p>

            <div className="form-group">
              <label htmlFor="triggerPrompt">Trigger Prompt</label>
              <textarea
                id="triggerPrompt"
                value={triggerPrompt}
                onChange={e => setTriggerPrompt(e.target.value)}
                placeholder="e.g., Check if there are any significant breaking news stories in the last hour."
                rows={3}
              />
            </div>

            {renderModelSelect(
              'triggerModel',
              triggerModel,
              setTriggerModel,
              'Use a cheap model for cost efficiency'
            )}
          </div>

          <div className="form-section">
            <h3>Main Action</h3>
            <p className="form-hint">
              When the trigger fires, this prompt will be sent and the response added to the conversation.
            </p>

            <div className="form-group">
              <label htmlFor="mainPrompt">Main Prompt</label>
              <textarea
                id="mainPrompt"
                value={mainPrompt}
                onChange={e => setMainPrompt(e.target.value)}
                placeholder="e.g., Summarize the most important news stories from the past hour."
                rows={3}
              />
            </div>

            {renderModelSelect(
              'mainModel',
              mainModel,
              setMainModel,
              'Use a capable model for quality responses'
            )}
          </div>

          <div className="form-section">
            <h3>Schedule</h3>

            <div className="form-group">
              <label htmlFor="interval">Check Interval</label>
              <select
                id="interval"
                value={intervalMinutes}
                onChange={e => setIntervalMinutes(Number(e.target.value))}
              >
                {INTERVAL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                />
                Enabled
              </label>
            </div>
          </div>

          <div className="trigger-config-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!isValid}>
              {isEditing ? 'Save Changes' : 'Create Trigger'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
