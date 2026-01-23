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

  // Default model - prefer sonnet for quality
  const defaultModel = conversation?.model
    || availableModels.find(m => m.key.includes('sonnet'))?.key
    || availableModels[0]?.key
    || 'anthropic/claude-sonnet-4-5-20250929';

  // Form state
  const [title, setTitle] = useState(conversation?.title || '');
  const [triggerPrompt, setTriggerPrompt] = useState(existingTrigger?.triggerPrompt || '');
  const [model, setModel] = useState(existingTrigger?.model || defaultModel);
  const [intervalMinutes, setIntervalMinutes] = useState(
    existingTrigger?.intervalMinutes || 60
  );
  const [enabled, setEnabled] = useState(existingTrigger?.enabled ?? true);

  // Check if a model is in the favorites list
  const isFavorite = (m: ModelInfo) => favoriteModels.includes(m.key);

  // Get favorite models (matched from available models)
  const favorites = availableModels.filter(isFavorite);

  // Get non-favorite models
  const nonFavorites = availableModels.filter(m => !isFavorite(m));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const config: TriggerConfig = {
      enabled,
      triggerPrompt,
      model,
      intervalMinutes,
      lastChecked: existingTrigger?.lastChecked,
      lastTriggered: existingTrigger?.lastTriggered,
      history: existingTrigger?.history,
    };

    onSave(config, isEditing ? undefined : title);
  };

  const isValid = triggerPrompt.trim() && (isEditing || title.trim());

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
                placeholder="e.g., Stock Price Monitor"
              />
            </div>
          )}

          <div className="form-section">
            <h3>Trigger Prompt</h3>
            <p className="form-hint">
              This prompt runs on a schedule. When the condition is met, the response will be added to the conversation.
              The model will compare against previous responses to detect meaningful changes.
            </p>

            <div className="form-group">
              <label htmlFor="triggerPrompt">Prompt</label>
              <textarea
                id="triggerPrompt"
                value={triggerPrompt}
                onChange={e => setTriggerPrompt(e.target.value)}
                placeholder="e.g., Let me know when AAPL stock moves more than 1% from the previous check."
                rows={4}
              />
            </div>

            <div className="form-group">
              <label htmlFor="model">Model</label>
              <select
                id="model"
                value={model}
                onChange={e => setModel(e.target.value)}
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
            </div>
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
