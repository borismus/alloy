import React from 'react';
import { RiffIntervention } from '../types';
import { MarkdownContent } from './MarkdownContent';
import { ObliqueStrategyCard } from './ObliqueStrategyCard';

interface InterventionCardProps {
  intervention: RiffIntervention;
  onDismiss: (id: string) => void;
  onNavigateToNote?: (noteName: string) => void;
}

// Allow custom URL protocols (wikilink:, provenance:) in addition to standard ones
function urlTransform(url: string): string {
  if (url.startsWith('wikilink:') || url.startsWith('provenance:')) {
    return url;
  }
  return url;
}

export const InterventionCard: React.FC<InterventionCardProps> = ({
  intervention,
  onDismiss,
  onNavigateToNote,
}) => {
  // Special handling for oblique strategies
  if (intervention.type === 'oblique-strategy') {
    return (
      <ObliqueStrategyCard
        strategyText={intervention.metadata?.obliqueCard || 'Strategy card'}
        interpretation={intervention.content}
        onDismiss={() => onDismiss(intervention.id)}
        onNavigateToNote={onNavigateToNote}
        urlTransform={urlTransform}
      />
    );
  }

  const getIcon = (type: RiffIntervention['type']) => {
    switch (type) {
      case 'big-question':
        return '🤔';
      case 'memory-recall':
        return '📝';
      case 'question-answer':
        return '💡';
      default:
        return '💬';
    }
  };

  const getTypeLabel = (type: RiffIntervention['type']) => {
    switch (type) {
      case 'big-question':
        return 'Big Question';
      case 'memory-recall':
        return 'Memory';
      case 'question-answer':
        return 'Answer';
      default:
        return 'Intervention';
    }
  };

  return (
    <div
      className={`riff-intervention-card riff-intervention-${intervention.type}`}
    >
      <div className="riff-intervention-header">
        <span className="riff-intervention-icon">{getIcon(intervention.type)}</span>
        <span className="riff-intervention-label">{getTypeLabel(intervention.type)}</span>
        <button
          className="riff-intervention-dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(intervention.id);
          }}
          aria-label="Dismiss intervention"
        >
          ×
        </button>
      </div>
      <div className="riff-intervention-content">
        <MarkdownContent
          content={intervention.content}
          onNavigateToNote={onNavigateToNote}
          urlTransform={urlTransform}
        />
      </div>
    </div>
  );
};
