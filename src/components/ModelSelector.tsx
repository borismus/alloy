import { useContext, useMemo, useState } from 'react';
import {
  Autocomplete,
  AutocompleteStateContext,
  Button,
  DialogTrigger,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  SearchField,
  type Key,
} from 'react-aria-components';
import { ModelInfo } from '../types';
import { useIsMobile } from '../hooks/useIsMobile';
import { providerLabel, providerTag } from '../utils/models';
import styles from './ModelSelector.module.css';

/** Small padlock, used to mark on-device (privacy-preserving) models. */
function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" fill="currentColor" />
      <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

/**
 * Provenance chip: short provider tag ("OR", "MLX", "ANT"). Local (loopback/LAN)
 * models render a green padlock variant to signal prompts stay off the cloud;
 * the full provider name is in the tooltip.
 */
function ProviderTag({ model }: { model: ModelInfo }) {
  const tag = providerTag(model.provider, model.key);
  const full = providerLabel(model.provider, model.key);
  if (model.local) {
    return (
      <span className={`${styles.providerTag} ${styles.providerTagLocal}`} title={`${full} · runs locally, not sent to the cloud`}>
        <LockIcon /> {tag}
      </span>
    );
  }
  return (
    <span className={styles.providerTag} title={full}>{tag}</span>
  );
}

/**
 * Turn a model id like "gemini-3.1-pro-preview" into "Gemini 3.1 Pro Preview"
 * for the trigger label when the catalog no longer returns the conversation's
 * model (renamed, deprecated), so existing conversations still read cleanly.
 */
function humanizeModelId(key: string): string {
  const tail = key.split('/').pop() ?? key;
  return tail
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * Pre-sorting key: 0 = exact, 1 = name prefix, 2 = name substring,
 * 3 = provider name/tag, 4 = key substring, 5 = no match. Lower wins.
 */
function rankMatch(query: string, model: ModelInfo): number {
  const q = query.toLowerCase();
  const name = model.name.toLowerCase();
  const key = model.key.toLowerCase();
  const provider = providerLabel(model.provider, model.key).toLowerCase();
  const tag = providerTag(model.provider, model.key).toLowerCase();
  if (name === q || key === q || provider === q || tag === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (provider.includes(q) || tag.includes(q)) return 3;
  if (key.includes(q)) return 4;
  return 5;
}

interface ModelSelectorProps {
  value: string;  // Format: "provider/model-id"
  onChange: (modelKey: string) => void;
  disabled: boolean;
  models: ModelInfo[];
  favoriteModels?: string[];  // Format: "provider/model-id"
  /** The one configured model used for new resources. */
  defaultModel?: string;
  /** Advance a model's star (hollow → favorite → default → hollow). Parent
   *  owns the state machine and persistence. */
  onCycleModelPreference?: (modelKey: string) => void;
}

export function ModelSelector({
  value,
  onChange,
  disabled,
  models,
  favoriteModels = [],
  defaultModel,
  onCycleModelPreference,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Focusing the search field on open pops the iOS software keyboard, which
  // resizes the visual viewport and moves the composer several hundred px — the
  // popover is positioned against the pre-keyboard layout and ends up stranded
  // underneath the keyboard, showing only the search box. Mobile users pick from
  // favorites far more often than they type, so leave focus to an explicit tap.
  const isMobile = useIsMobile();

  const selectedModel = models.find(m => m.key === value);
  const selectedLabel = selectedModel?.name
    || (value ? humanizeModelId(value) : '')
    || 'Select Model';

  // Use onAction (fires on every row activation) rather than onSelectionChange
  // so clicking the already-selected model still closes the picker.
  const handlePick = (key: Key) => {
    onChange(String(key));
    setIsOpen(false);
  };

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={(open) => !disabled && setIsOpen(open)}>
      <Button className={styles.trigger} isDisabled={disabled} aria-label={`Model: ${selectedLabel}`}>
        {selectedModel && <ProviderTag model={selectedModel} />}
        <span className={styles.triggerLabel}>{selectedLabel}</span>
        <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      <Popover className={styles.popover} placement="top end">
        {/* Autocomplete provides the search-to-list keyboard bridge; filtering
            and ranking are done in ModelResults so the list can show favorites
            only when empty, so disable Autocomplete's own filter. */}
        <Autocomplete filter={() => true}>
          <SearchField className={styles.search} aria-label="Search models" autoFocus={!isMobile}>
            <Input className={styles.searchInput} placeholder="Search models…" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
          </SearchField>
          <ModelResults
            value={value}
            models={models}
            favoriteModels={favoriteModels}
            defaultModel={defaultModel}
            onPick={handlePick}
            onCycleModelPreference={onCycleModelPreference}
          />
        </Autocomplete>
      </Popover>
    </DialogTrigger>
  );
}

interface ModelResultsProps {
  value: string;
  models: ModelInfo[];
  favoriteModels: string[];
  defaultModel?: string;
  onPick: (key: Key) => void;
  onCycleModelPreference?: (modelKey: string) => void;
}

type ModelPreference = 'none' | 'favorite' | 'default';

interface PreferenceControlProps {
  model: ModelInfo;
  preference: ModelPreference;
  onCycle?: (modelKey: string) => void;
}

/**
 * One star, three states. Each activation advances hollow → yellow favorite →
 * red default → hollow; the label always describes what the next click does.
 */
function PreferenceControl({ model, preference, onCycle }: PreferenceControlProps) {
  const label = preference === 'default'
    ? `Remove ${model.name} as default`
    : preference === 'favorite'
      ? `Make ${model.name} the default model`
      : `Add ${model.name} to favorites`;

  return (
    <span
      role="button"
      tabIndex={0}
      className={`${styles.star} ${preference === 'favorite' ? styles.starOn : ''} ${preference === 'default' ? styles.starDefault : ''}`}
      aria-label={label}
      title={label}
      data-preference={preference}
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => {
        event.stopPropagation();
        onCycle?.(model.key);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onCycle?.(model.key);
      }}
    >
      {preference === 'none' ? '☆' : '★'}
    </span>
  );
}

// Reads the live query from the Autocomplete so the list can show favorites
// only when empty and relevance-ranked matches while searching.
function ModelResults({
  value,
  models,
  favoriteModels,
  defaultModel,
  onPick,
  onCycleModelPreference,
}: ModelResultsProps) {
  const state = useContext(AutocompleteStateContext);
  const query = (state?.inputValue ?? '').trim();
  const preferenceFor = (key: string): ModelPreference =>
    key === defaultModel ? 'default' : favoriteModels.includes(key) ? 'favorite' : 'none';
  const hasPinnedModels = models.some(model => preferenceFor(model.key) !== 'none');

  // Rows shown while this popover has been open. Cycling a star must restyle
  // the row, not yank it out from under the pointer — so the empty-query list
  // can grow (newly starred models) but never shrinks until the next open.
  // ModelResults remounts with the popover, so this resets naturally.
  const [sessionPinnedKeys] = useState(() => new Set<string>());

  const rows = useMemo<Array<ModelInfo & { preference: ModelPreference }>>(() => {
    let list: ModelInfo[];
    if (query.length === 0) {
      for (const model of models) {
        if (preferenceFor(model.key) !== 'none') sessionPinnedKeys.add(model.key);
      }
      // Only when nothing at all is starred does the selected model earn a
      // pin, so the picker never looks empty — but an unstarred model must NOT
      // reappear beside the remaining favorites on the next open.
      if (sessionPinnedKeys.size === 0) {
        const selected = models.find(model => model.key === value);
        if (selected) sessionPinnedKeys.add(selected.key);
      }
      list = models.filter(model => sessionPinnedKeys.has(model.key));
    } else {
      list = models
        .map(m => ({ m, rank: rankMatch(query, m) }))
        .filter(x => x.rank < 5)
        .sort((a, b) => a.rank - b.rank || a.m.name.localeCompare(b.m.name))
        .map(x => x.m);
    }
    // Bake preference into each row so the row's identity changes when config
    // changes; otherwise React Aria caches the row by key and the star can keep
    // its previous color/accessible label.
    return list.map(model => ({ ...model, preference: preferenceFor(model.key) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, value, models, favoriteModels, defaultModel]);

  return (
    <ListBox
      className={styles.list}
      aria-label="Models"
      items={rows}
      onAction={onPick}
      renderEmptyState={() => (
        <div className={styles.empty}>
          {query.length === 0
            ? (hasPinnedModels ? 'No pinned models match.' : 'No favorites yet — type to find a model, then ☆ for options.')
            : 'No models match your search.'}
        </div>
      )}
    >
      {(model) => (
        <ListBoxItem
          id={model.key}
          textValue={model.name}
          className={`${styles.option} ${model.key === value ? styles.optionCurrent : ''}`}
        >
          <PreferenceControl
            model={model}
            preference={model.preference}
            onCycle={onCycleModelPreference}
          />
          <ProviderTag model={model} />
          <span className={styles.optionName}>{model.name}</span>
        </ListBoxItem>
      )}
    </ListBox>
  );
}
