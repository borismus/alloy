import React from 'react';
import './ItemHeader.css';

interface ItemHeaderProps {
  title: string;
  onBack?: () => void;
  canGoBack?: boolean;
  onForward?: () => void;
  canGoForward?: boolean;
  onClose?: () => void; // X button to dismiss/return to background
  children?: React.ReactNode; // For action buttons on the right
}

export const ItemHeader: React.FC<ItemHeaderProps> = ({
  title,
  onBack,
  canGoBack = true,
  onForward,
  canGoForward = false,
  onClose,
  children,
}) => {
  return (
    <div className="item-header">
      <div className="item-header-title">
        <button
          className="btn-back"
          onClick={onBack}
          disabled={!canGoBack || !onBack}
          title={canGoBack && onBack ? "Go back" : "No previous view"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        {onForward && (
          <button
            className="btn-forward"
            onClick={onForward}
            disabled={!canGoForward}
            title={canGoForward ? "Go forward" : "No next view"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
        <h2>{title}</h2>
      </div>
      {(children || onClose) && (
        <div className="item-header-actions">
          {children}
          {onClose && (
            <button
              className="btn-close"
              onClick={onClose}
              title="Close"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
