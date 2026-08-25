import React from 'react';
import { useOpenSettings } from '../contexts/SettingsLauncherContext';
import { AlloyTooltip, Button } from './ui';
import './ItemHeader.css';

interface ItemHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  onBack?: () => void;
  canGoBack?: boolean;
  onForward?: () => void;
  canGoForward?: boolean;
  onClose?: () => void; // X button to dismiss
  children?: React.ReactNode; // For action buttons on the right
}

export const ItemHeader: React.FC<ItemHeaderProps> = ({
  title,
  subtitle,
  onBack,
  canGoBack = true,
  onForward,
  canGoForward = false,
  onClose,
  children,
}) => {
  const openSettings = useOpenSettings();
  return (
    <div className="item-header">
      <div className="item-header-title">
        <Button
          variant="quiet"
          size="icon"
          onPress={onBack}
          isDisabled={!canGoBack || !onBack}
          aria-label="Go back"
          title={canGoBack && onBack ? "Go back" : "No previous view"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </Button>
        {onForward && (
          <Button
            variant="quiet"
            size="icon"
            onPress={onForward}
            isDisabled={!canGoForward}
            aria-label="Go forward"
            title={canGoForward ? "Go forward" : "No next view"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Button>
        )}
        <div className="item-header-heading">
          <h2>{title}</h2>
          {subtitle && <div className="item-header-subtitle">{subtitle}</div>}
        </div>
      </div>
      {(children || onClose || openSettings) && (
        <div className="item-header-actions">
          {children}
          {openSettings && (
            <AlloyTooltip content="Settings">
              <Button
                variant="quiet"
                size="icon"
                onPress={openSettings}
                aria-label="Open settings"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.49.49 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" />
                </svg>
              </Button>
            </AlloyTooltip>
          )}
          {onClose && (
            <AlloyTooltip content="Close">
              <Button
                variant="quiet"
                size="compactIcon"
                data-header-close
                onPress={onClose}
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </Button>
            </AlloyTooltip>
          )}
        </div>
      )}
    </div>
  );
};
