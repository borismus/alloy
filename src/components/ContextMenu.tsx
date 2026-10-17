/**
 * Context Menu Component
 *
 * React-based dropdown menu that appears on right-click.
 * Used in server/browser modes where native context menus aren't available.
 */

import React, { useEffect, useRef } from 'react';
import { useContextMenu, setGlobalShowMenu, ContextMenuItem } from '../contexts/ContextMenuContext';
import './ContextMenu.css';

export const ContextMenu: React.FC = () => {
  const { menuState, hideMenu, showMenu } = useContextMenu();
  const menuRef = useRef<HTMLDivElement>(null);

  // Register global showMenu for tauri-menu.ts mock
  useEffect(() => {
    setGlobalShowMenu(showMenu);
    return () => setGlobalShowMenu(null);
  }, [showMenu]);

  // Handle click outside to close menu
  useEffect(() => {
    if (!menuState.visible) return;

    const openedAt = Date.now();
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      // Ignore the trailing events of the gesture that opened the menu (e.g. the
      // synthesized mousedown from a tap release on touch).
      if (Date.now() - openedAt < 300) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideMenu();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hideMenu();
      }
    };

    // Small delay to prevent immediate close from the triggering click
    setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuState.visible, hideMenu]);

  // Take focus while open so the arrow keys work, and hand it back on close.
  useEffect(() => {
    if (!menuState.visible) return;
    const previous = document.activeElement as HTMLElement | null;
    const menu = menuRef.current;
    menu?.focus({ preventScroll: true });
    return () => {
      if (!previous?.isConnected) return;
      const active = document.activeElement;
      if (!active || active === document.body || menu?.contains(active)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [menuState.visible]);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (!menuState.visible || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let { x, y } = menuState;

    // Adjust if menu would go off right edge
    if (x + rect.width > viewportWidth) {
      x = viewportWidth - rect.width - 8;
    }

    // Adjust if menu would go off bottom edge
    if (y + rect.height > viewportHeight) {
      y = viewportHeight - rect.height - 8;
    }

    // Ensure minimum position
    x = Math.max(8, x);
    y = Math.max(8, y);

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [menuState]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.enabled !== false && item.action) {
      item.action();
    }
    hideMenu();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0
        ? (step > 0 ? 0 : items.length - 1)
        : (current + step + items.length) % items.length;
      items[next].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      e.preventDefault();
      const item = menuState.items.find(i => i.id === items[index].dataset.itemId);
      if (item) handleItemClick(item);
    }
  };

  if (!menuState.visible) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        left: menuState.x,
        top: menuState.y,
      }}
    >
      {menuState.items.map((item) => (
        <div
          key={item.id}
          role="menuitem"
          tabIndex={-1}
          data-item-id={item.id}
          aria-disabled={item.enabled === false || undefined}
          className={[
            'context-menu-item',
            item.enabled === false && 'disabled',
            item.danger && 'danger',
            item.separatorBefore && 'separator-before',
          ].filter(Boolean).join(' ')}
          onClick={() => handleItemClick(item)}
        >
          {item.text}
        </div>
      ))}
    </div>
  );
};
