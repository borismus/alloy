import React from 'react';
import type { QueuedMessage } from '../types';

interface QueuedMessagesListProps {
  queue: QueuedMessage[];
  onRemove: (messageId: string) => void;
}

export const QueuedMessagesList = React.memo(({ queue, onRemove }: QueuedMessagesListProps) => {
  if (queue.length === 0) return null;

  return (
    <div className="queued-messages">
      {queue.map((qm) => (
        <div key={qm.id} className="queued-message">
          <div className="queued-message-content">
            {qm.pendingImages.length > 0 && (
              <span className="queued-images-badge">
                {qm.pendingImages.length} image{qm.pendingImages.length > 1 ? 's' : ''}
              </span>
            )}
            <span className="queued-message-text">
              {qm.content.length > 100 ? qm.content.slice(0, 100) + '…' : qm.content}
            </span>
          </div>
          <button
            className="queued-message-remove"
            onClick={() => onRemove(qm.id)}
            aria-label="Remove queued message"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
});
