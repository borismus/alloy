import React from 'react';
import { HeaderActions } from './HeaderActions';
import { CopyButton } from './CodeBlock';
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
  return (
    // Draggable in the desktop app, which has no title bar of its own.
    <div className="item-header" data-tauri-drag-region>
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
        {/* The title drags the window too (so it can't be selected), hence
            the copy button beside it. */}
        <div className="item-header-heading" data-tauri-drag-region>
          <div className="item-header-title-row" data-tauri-drag-region>
            <h2 data-tauri-drag-region>{title}</h2>
            <CopyButton text={title} label="Copy title" className="item-header-copy" />
          </div>
          {subtitle && <div className="item-header-subtitle" data-tauri-drag-region>{subtitle}</div>}
        </div>
      </div>
      <div className="item-header-actions">
        {children}
        <HeaderActions />
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
    </div>
  );
};
