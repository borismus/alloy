/**
 * Mock implementation of @tauri-apps/api/menu
 *
 * No-op menu system for browser mode.
 */

interface MenuItemOptions {
  id?: string;
  text?: string;
  enabled?: boolean;
  action?: () => void;
}

interface MenuOptions {
  items?: MenuItem[];
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
  private items: MenuItem[] = [];

  constructor(_options?: MenuOptions) {
    // No-op
  }

  static async new(_options?: MenuOptions): Promise<Menu> {
    return new Menu(_options);
  }

  async append(item: MenuItem): Promise<void> {
    this.items.push(item);
  }

  async popup(): Promise<void> {
    console.log('[MockMenu] popup() - no-op in browser mode');
    // Could implement a custom context menu here if needed
  }

  async close(): Promise<void> {
    // No-op
  }
}

export { MenuItem };
