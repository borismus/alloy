import { createContext, useContext, type ReactNode } from 'react';

/**
 * Provides a callback to open the Settings dialog, so shared chrome (the
 * ItemHeader gear) can launch Settings without threading a prop through every
 * view. App supplies the value; ItemHeader consumes it.
 */
const SettingsLauncherContext = createContext<(() => void) | null>(null);

export function SettingsLauncherProvider({
  open,
  children,
}: {
  open: () => void;
  children: ReactNode;
}) {
  return (
    <SettingsLauncherContext.Provider value={open}>
      {children}
    </SettingsLauncherContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOpenSettings(): (() => void) | null {
  return useContext(SettingsLauncherContext);
}
