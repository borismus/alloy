import React, { useMemo } from 'react';
import { lineDiff, collapseDiff } from '../utils/lineDiff';
import './DiffView.css';

interface DiffViewProps {
  oldText: string;
  newText: string;
  /** Unchanged lines of context to keep around each change. */
  context?: number;
}

const SIGN: Record<string, string> = { add: '+', del: '−', context: '\u00A0' };

export const DiffView: React.FC<DiffViewProps> = ({ oldText, newText, context = 3 }) => {
  const items = useMemo(
    () => collapseDiff(lineDiff(oldText, newText), context),
    [oldText, newText, context],
  );

  return (
    <div className="diff-view" role="table" aria-label="Proposed changes">
      {items.map((item, idx) => {
        if (item.type === 'gap') {
          return (
            <div key={idx} className="diff-gap">
              ··· {item.count} unchanged line{item.count !== 1 ? 's' : ''} ···
            </div>
          );
        }
        return (
          <div key={idx} className={`diff-row diff-${item.type}`}>
            <span className="diff-sign" aria-hidden="true">{SIGN[item.type]}</span>
            <span className="diff-text">{item.text === '' ? '\u00A0' : item.text}</span>
          </div>
        );
      })}
    </div>
  );
};
