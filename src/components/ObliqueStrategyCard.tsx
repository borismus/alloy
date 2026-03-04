import React from 'react';
import { MarkdownContent } from './MarkdownContent';
import './ObliqueStrategyCard.css';

interface ObliqueStrategyCardProps {
  strategyText: string;
  interpretation: string;
  onDismiss: () => void;
  onNavigateToNote?: (noteName: string) => void;
}

export const ObliqueStrategyCard: React.FC<ObliqueStrategyCardProps> = ({
  strategyText,
  interpretation,
  onDismiss,
  onNavigateToNote,
}) => {
  return (
    <div className="oblique-strategy-card">
      <div className="oblique-card-face">
        <div className="oblique-card-title">OBLIQUE STRATEGY</div>
        <div className="oblique-card-text">{strategyText}</div>
      </div>
      <div className="oblique-card-interpretation">
        <MarkdownContent
          content={interpretation}
          onNavigateToNote={onNavigateToNote}
        />
      </div>
      <button
        className="oblique-card-dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss strategy"
      >
        ×
      </button>
    </div>
  );
};
