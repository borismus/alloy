import React from 'react';
import './ItemHeader.css';

interface ItemHeaderProps {
  title: string;
  onBack?: () => void;
  canGoBack?: boolean;
  children?: React.ReactNode; // For action buttons on the right
}

export const ItemHeader: React.FC<ItemHeaderProps> = ({
  title,
  onBack,
  canGoBack = true,
  children,
}) => {
  return (
    <div className="item-header">
      <div className="item-header-title">
        {onBack && (
          <button
            className="btn-back"
            onClick={onBack}
            disabled={!canGoBack}
            title={canGoBack ? "Go back" : "No previous view"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        <h2>{title}</h2>
      </div>
      {children && (
        <div className="item-header-actions">
          {children}
        </div>
      )}
    </div>
  );
};
