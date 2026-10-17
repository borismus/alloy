import { createContext, useContext, type ReactNode } from 'react';

/**
 * The app-wide header actions (new conversation, open Settings), so shared
 * chrome — the item header and the phone's list header — can offer them
 * without threading props through every view. App supplies the value.
 */
export interface HeaderActionsValue {
  newConversation: () => void;
  openSettings: () => void;
}

const HeaderActionsContext = createContext<HeaderActionsValue | null>(null);

export function HeaderActionsProvider({
  value,
  children,
}: {
  value: HeaderActionsValue;
  children: ReactNode;
}) {
  return (
    <HeaderActionsContext.Provider value={value}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHeaderActions(): HeaderActionsValue | null {
  return useContext(HeaderActionsContext);
}
