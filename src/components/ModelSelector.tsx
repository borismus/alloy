import { useState, useRef, useEffect, useMemo } from 'react';
import { ModelInfo } from '../types';
import './ModelSelector.css';

interface ModelSelectorProps {
  value: string;  // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  onChange: (modelKey: string) => void;  // Now takes the unified key
  disabled: boolean;
  models: ModelInfo[];
  favoriteModels?: string[];  // Format: "provider/model-id"
  /** Toggle a model in/out of the favorites list. Parent persists. */
  onToggleFavorite?: (modelKey: string) => void;
}

/**
 * Turn a model id like "gemini-3.1-pro-preview" into "Gemini 3.1 Pro Preview"
 * for the button label when the catalog doesn't return the conversation's
 * model (renamed, deprecated). Better than dumping the raw id — matches the
 * vibe of OpenRouter's `name` field for in-catalog models.
 */
function humanizeModelId(key: string): string {
  // Strip the routing prefix (`openrouter/`) and the vendor (`anthropic/`),
  // leaving the bare model id slug.
  const tail = key.split('/').pop() ?? key;
  return tail
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Pre-sorting key: 0 = exact, 1 = name prefix, 2 = name substring, 3 = key
 * substring, 4 = no match (filtered out elsewhere). Lower wins.
 */
function rankMatch(query: string, model: ModelInfo): number {
  const q = query.toLowerCase();
  const name = model.name.toLowerCase();
  const key = model.key.toLowerCase();
  if (name === q || key === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (key.includes(q)) return 3;
  return 4;
}

export function ModelSelector({
  value,
  onChange,
  disabled,
  models,
  favoriteModels = [],
  onToggleFavorite,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<'below' | 'above'>('below');
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedModel = models.find(m => m.key === value);

  // Stale-model fallback: when the conversation was last used with a model
  // that /api/models no longer returns (renamed, deprecated, regional
  // alias), humanize the id (`gemini-3.1-pro-preview` → `Gemini 3.1 Pro
  // Preview`) so existing conversations look consistent with in-catalog ones.
  const selectedLabel = selectedModel?.name
    || (value ? humanizeModelId(value) : '')
    || 'Select Model';

  const isFavorite = (key: string) => favoriteModels.includes(key);

  // The list rendered in the dropdown. Without a search query, this is
  // favorites only (with the currently-selected model pinned at top if it
  // isn't already favorited). With a query, it's everything that matches,
  // ranked by relevance.
  const rows: ModelInfo[] = useMemo(() => {
    if (search.trim().length === 0) {
      const favs = models.filter(m => isFavorite(m.key));
      // Pin the selected model at the top if it isn't already a favorite,
      // so the picker never looks empty when something is selected.
      if (selectedModel && !isFavorite(selectedModel.key)) {
        return [selectedModel, ...favs];
      }
      return favs;
    }
    return models
      .map(m => ({ m, rank: rankMatch(search, m) }))
      .filter(x => x.rank < 4)
      .sort((a, b) => a.rank - b.rank || a.m.name.localeCompare(b.m.name))
      .map(x => x.m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, models, favoriteModels, selectedModel]);

  // Reset active row when the visible list changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [search, isOpen]);

  // Click outside closes.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Auto-focus search input on open + reset search when closed.
  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    } else {
      setSearch('');
    }
  }, [isOpen]);

  // Decide whether to flip the dropdown above the button.
  useEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const estimated = Math.min(rows.length * 44 + 60, 360);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setDropdownPosition(spaceBelow < estimated && spaceAbove > spaceBelow ? 'above' : 'below');
  }, [isOpen, rows.length]);

  const handleSelect = (modelKey: string) => {
    onChange(modelKey);
    setIsOpen(false);
  };

  const handleToggleFavorite = (e: React.MouseEvent, modelKey: string) => {
    e.stopPropagation();
    onToggleFavorite?.(modelKey);
  };

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) handleSelect(row.key);
    }
  };

  const hasFavorites = favoriteModels.length > 0;
  const showingFavorites = search.trim().length === 0;

  return (
    <div className="model-selector-container" ref={dropdownRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`model-selector-button ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <span>{selectedLabel}</span>
        <svg className={`chevron ${isOpen ? 'open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {isOpen && (
        <div className={`model-selector-dropdown ${dropdownPosition}`}>
          <div className="model-selector-search">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKey}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {search && (
              <button
                type="button"
                className="model-selector-clear"
                onClick={() => { setSearch(''); searchInputRef.current?.focus(); }}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          <div className="model-selector-section-header">
            {showingFavorites
              ? 'Favorites'
              : `${rows.length} match${rows.length === 1 ? '' : 'es'}`}
          </div>

          <div className="model-selector-list">
            {rows.length === 0 ? (
              <div className="model-selector-empty">
                {hasFavorites
                  ? 'No models match your search.'
                  : 'No favorites yet — type to find a model, then ☆ to add it.'}
              </div>
            ) : (
              rows.map((model, idx) => {
                const fav = isFavorite(model.key);
                const selected = model.key === value;
                const active = idx === activeIndex;
                return (
                  <div
                    key={model.key}
                    className={`model-option ${selected ? 'selected' : ''} ${active ? 'active' : ''}`}
                    onClick={() => handleSelect(model.key)}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <button
                      type="button"
                      className={`model-option-star ${fav ? 'is-favorite' : ''}`}
                      onClick={(e) => handleToggleFavorite(e, model.key)}
                      aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
                      title={fav ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      {fav ? '★' : '☆'}
                    </button>
                    <span className="model-option-name">{model.name}</span>
                    {selected && (
                      <svg className="model-option-check" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
