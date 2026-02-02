/**
 * Context Menu Context
 *
 * Provides a React-based context menu system for server/browser modes
 * where native menus aren't available.
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface ContextMenuItem {
  id: string;
  text: string;
  enabled?: boolean;
  action?: () => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuContextValue {
  showMenu: (items: ContextMenuItem[], x: number, y: number) => void;
  hideMenu: () => void;
  menuState: ContextMenuState;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

export const useContextMenu = (): ContextMenuContextValue => {
  const context = useContext(ContextMenuContext);
  if (!context) {
    throw new Error('useContextMenu must be used within ContextMenuProvider');
  }
  return context;
};

interface ContextMenuProviderProps {
  children: ReactNode;
}

export const ContextMenuProvider: React.FC<ContextMenuProviderProps> = ({ children }) => {
  const [menuState, setMenuState] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    items: [],
  });

  const showMenu = useCallback((items: ContextMenuItem[], x: number, y: number) => {
    setMenuState({
      visible: true,
      x,
      y,
      items,
    });
  }, []);

  const hideMenu = useCallback(() => {
    setMenuState(prev => ({
      ...prev,
      visible: false,
    }));
  }, []);

  return (
    <ContextMenuContext.Provider value={{ showMenu, hideMenu, menuState }}>
      {children}
    </ContextMenuContext.Provider>
  );
};

// Global reference for use from tauri-menu.ts mock
let globalShowMenu: ((items: ContextMenuItem[], x: number, y: number) => void) | null = null;

export const setGlobalShowMenu = (fn: typeof globalShowMenu) => {
  globalShowMenu = fn;
};

export const getGlobalShowMenu = () => globalShowMenu;
