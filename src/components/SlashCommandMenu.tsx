import React from 'react';
import { ListBox, ListBoxItem, type ListBoxProps } from 'react-aria-components';
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

// Focus stays in the composer's textarea while the menu is open, so picking
// an option must not move it (on the phone that would drop the keyboard).
// React Aria forwards this option to useListBox, though ListBox doesn't type it.
const VIRTUAL_FOCUS = { shouldUseVirtualFocus: true } as Partial<ListBoxProps<SlashCommandItem>>;

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
  const activeName = items[activeIndex]?.name;
  return (
    <ListBox
      {...VIRTUAL_FOCUS}
      className="slash-command-menu"
      aria-label="Skills"
      items={items}
      dependencies={[activeName]}
      onAction={(key) => {
        const item = items.find((candidate) => candidate.name === key);
        if (item) onSelect(item);
      }}
    >
      {(item) => (
        <ListBoxItem
          id={item.name}
          textValue={item.name}
          className={`slash-command-item ${item.name === activeName ? 'active' : ''}`}
          onHoverStart={() => onHover(items.indexOf(item))}
        >
          <span className="slash-command-name">/{item.name}</span>
          {item.description && (
            <span className="slash-command-desc">{item.description}</span>
          )}
        </ListBoxItem>
      )}
    </ListBox>
  );
};
