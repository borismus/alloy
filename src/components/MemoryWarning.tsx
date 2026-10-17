import { useState } from 'react';
import { Button } from './ui';
import './UpdateChecker.css';

// 8KB limit for memory file
export const MEMORY_SIZE_LIMIT = 8 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface MemoryWarningProps {
  sizeBytes: number;
  onEdit: () => void;
}

export function MemoryWarning({ sizeBytes, onEdit }: MemoryWarningProps) {
  const [dismissed, setDismissed] = useState(false);

  // Don't show if under limit or dismissed
  if (sizeBytes <= MEMORY_SIZE_LIMIT || dismissed) {
    return null;
  }

  return (
    <div className="update-banner update-banner-warning">
      <div className="update-content">
        <div className="update-info">
          <span className="update-icon">!</span>
          <span className="update-text">
            Memory file is {formatBytes(sizeBytes)} (limit: {formatBytes(MEMORY_SIZE_LIMIT)})
          </span>
        </div>
        <div className="update-actions">
          <Button variant="secondary" size="small" onPress={onEdit}>
            Edit memory.md
          </Button>
          <Button variant="muted" size="small" onPress={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
