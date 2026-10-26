import { useRef } from 'react';
import { useHeaderActions } from '../contexts/HeaderActionsContext';
import { getDebugOverlay, setDebugOverlay } from '../services/debugOverlay';
import { AlloyTooltip, Button } from './ui';
import './HeaderActions.css';

/** How long to hold the settings button to toggle the debug overlay, in ms. */
export const OVERLAY_LONG_PRESS_MS = 600;

/**
 * [+] [⚙] at the top right of every header, on desktop and phone alike.
 * Renders nothing outside a HeaderActionsProvider.
 */
export function HeaderActions() {
  const actions = useHeaderActions();
  // Holding the settings button toggles the viewport debug overlay. The bugs it
  // chases can stop Settings from opening, so its switch there isn't enough.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldLong = useRef(false);
  if (!actions) return null;
  const startHold = () => {
    heldLong.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      heldLong.current = true;
      setDebugOverlay(!getDebugOverlay());
    }, OVERLAY_LONG_PRESS_MS);
  };
  const endHold = () => clearTimeout(holdTimer.current);
  const pressSettings = () => {
    if (heldLong.current) {
      heldLong.current = false;
      return;
    }
    actions.openSettings();
  };
  return (
    <div className="header-actions">
      <AlloyTooltip content="New conversation">
        <Button
          variant="quiet"
          size="icon"
          onPress={actions.newConversation}
          aria-label="New conversation"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12h8M12 8v8" />
          </svg>
        </Button>
      </AlloyTooltip>
      <AlloyTooltip content="Settings">
        <Button
          variant="quiet"
          size="icon"
          onPress={pressSettings}
          onPressStart={startHold}
          onPressEnd={endHold}
          aria-label="Open settings"
        >
          <SettingsIcon />
        </Button>
      </AlloyTooltip>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
