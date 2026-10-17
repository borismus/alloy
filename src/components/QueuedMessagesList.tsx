import React from 'react';
import type { QueuedMessage } from '../types';
import { IconButton } from './ui';

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
            {qm.pendingAttachments.length > 0 && (
              <span className="queued-images-badge">
                {qm.pendingAttachments.length} attachment{qm.pendingAttachments.length > 1 ? 's' : ''}
              </span>
            )}
            <span className="queued-message-text">
              {qm.content}
            </span>
          </div>
          <IconButton label="Remove queued message" size="compactIcon" onPress={() => onRemove(qm.id)}>
            <span className="queued-message-remove" aria-hidden="true">×</span>
          </IconButton>
        </div>
      ))}
    </div>
  );
});
