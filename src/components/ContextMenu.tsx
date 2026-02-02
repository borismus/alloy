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

    const handleClickOutside = (e: MouseEvent) => {
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
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuState.visible, hideMenu]);

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

  if (!menuState.visible) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        position: 'fixed',
        left: menuState.x,
        top: menuState.y,
      }}
    >
      {menuState.items.map((item) => (
        <div
          key={item.id}
          className={`context-menu-item ${item.enabled === false ? 'disabled' : ''}`}
          onClick={() => handleItemClick(item)}
        >
          {item.text}
        </div>
      ))}
    </div>
  );
};
