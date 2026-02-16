/**
 * Mock implementation of @tauri-apps/api/menu
 *
 * In server/browser mode, shows a React-based context menu.
 */

import { getGlobalShowMenu, ContextMenuItem } from '../contexts/ContextMenuContext';
import { isServerMode } from './index';

interface MenuItemOptions {
  id?: string;
  text?: string;
  enabled?: boolean;
  action?: () => void;
}

interface MenuOptions {
  items?: MenuItemOptions[];
}

// Track last mouse position for menu placement
let lastMouseX = 0;
let lastMouseY = 0;

// Update mouse position on every contextmenu event
if (typeof window !== 'undefined') {
  document.addEventListener('contextmenu', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  // Also track regular mouse events for the FAB menu case
  document.addEventListener('mousedown', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
}

class MenuItem {
  id: string;
  text: string;
  enabled: boolean;
  action?: () => void;

  constructor(options: MenuItemOptions) {
    this.id = options.id || '';
    this.text = options.text || '';
    this.enabled = options.enabled ?? true;
    this.action = options.action;
  }
}

export class Menu {
  private items: ContextMenuItem[] = [];

  constructor(options?: MenuOptions) {
    if (options?.items) {
      this.items = options.items.map(item => ({
        id: item.id || '',
        text: item.text || '',
        enabled: item.enabled ?? true,
        action: item.action,
      }));
    }
  }

  static async new(options?: MenuOptions): Promise<Menu> {
    return new Menu(options);
  }

  async append(item: MenuItem): Promise<void> {
    this.items.push({
      id: item.id,
      text: item.text,
      enabled: item.enabled,
      action: item.action,
    });
  }

  async popup(): Promise<void> {
    if (isServerMode() || !('__TAURI_INTERNALS__' in window)) {
      const showMenu = getGlobalShowMenu();
      if (showMenu) {
        showMenu(this.items, lastMouseX, lastMouseY);
      }
    }
  }

  async close(): Promise<void> {
    // No-op - menu closes on click outside
  }
}

export { MenuItem };
