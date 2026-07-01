import React from 'react';
import './SlashCommandMenu.css';

export interface SlashCommandItem {
  name: string;
  description: string;
}

interface SlashCommandMenuProps {
  items: SlashCommandItem[];
  activeIndex: number;
  onSelect: (item: SlashCommandItem) => void;
  onHover: (index: number) => void;
}

/**
 * Autocomplete menu shown above the composer while typing a `/skill_name`
 * command. Presentational — the composer owns filtering, the active index, and
 * keyboard navigation.
 */
export const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
  items,
  activeIndex,
  onSelect,
  onHover,
}) => {
  if (items.length === 0) return null;
  return (
    <div className="slash-command-menu" role="listbox" aria-label="Skills">
      {items.map((item, idx) => (
        <button
          key={item.name}
          type="button"
          role="option"
          aria-selected={idx === activeIndex}
          className={`slash-command-item ${idx === activeIndex ? 'active' : ''}`}
          // mousedown (not click) so selecting doesn't blur the textarea first.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
          onMouseEnter={() => onHover(idx)}
        >
          <span className="slash-command-name">/{item.name}</span>
          {item.description && (
            <span className="slash-command-desc">{item.description}</span>
          )}
        </button>
      ))}
    </div>
  );
};
