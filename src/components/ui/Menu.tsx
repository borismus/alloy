import type { ReactNode } from 'react';
import {
  Menu,
  MenuItem,
  Popover,
  type Key,
} from 'react-aria-components';
import styles from './Menu.module.css';

export interface MenuOption {
  id: string;
  label: string;
  detail?: string;
}

export interface AlloyMenuProps {
  items: MenuOption[];
  onAction: (key: Key) => void;
  header?: ReactNode;
  placement?: 'bottom start' | 'bottom end' | 'top start' | 'top end';
}

/**
 * Alloy dropdown menu, built on React Aria's Popover + Menu. Wrap in a
 * `MenuTrigger` (from react-aria-components) around a trigger button and this
 * component. Menu handles keyboard navigation, typeahead, and dismissal.
 */
export function AlloyMenu({ items, onAction, header, placement = 'bottom start' }: AlloyMenuProps) {
  return (
    <Popover className={styles.popover} placement={placement}>
      {header && <div className={styles.header}>{header}</div>}
      <Menu className={styles.menu} items={items} onAction={onAction}>
        {(item) => (
          <MenuItem className={styles.item} id={item.id} textValue={item.label}>
            <span>{item.label}</span>
            {item.detail && <small>{item.detail}</small>}
          </MenuItem>
        )}
      </Menu>
    </Popover>
  );
}
