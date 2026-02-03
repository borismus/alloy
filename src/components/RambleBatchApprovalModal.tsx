import React from 'react';
import { ProposedChange } from '../types';
import './RambleBatchApprovalModal.css';

interface RambleBatchApprovalModalProps {
  proposedChanges: ProposedChange[];
  isProcessing: boolean;
  onApply: () => void;
  onCancel: () => void;
}

export const RambleBatchApprovalModal: React.FC<RambleBatchApprovalModalProps> = ({
  proposedChanges,
  isProcessing,
  onApply,
  onCancel,
}) => {
  if (proposedChanges.length === 0) {
    return (
      <div className="ramble-modal-overlay">
        <div className="ramble-modal">
          <div className="ramble-modal-header">
            <h3>Integration Complete</h3>
          </div>
          <div className="ramble-modal-content">
            <p className="ramble-modal-empty">No integrations proposed. Your ramble has been saved.</p>
          </div>
          <div className="ramble-modal-actions">
            <button className="ramble-modal-btn ramble-modal-btn-primary" onClick={onCancel}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ramble-modal-overlay">
      <div className="ramble-modal">
        <div className="ramble-modal-header">
          <h3>Integrate Insights</h3>
          <span className="ramble-modal-count">{proposedChanges.length} change{proposedChanges.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="ramble-modal-content">
          <div className="ramble-modal-changes">
            {proposedChanges.map((change, index) => (
              <div key={index} className="ramble-change-item">
                <div className="ramble-change-header">
                  <span className={`ramble-change-type ramble-change-type-${change.type}`}>
                    {change.type}
                  </span>
                  <span className="ramble-change-path">{change.path}</span>
                </div>
                <p className="ramble-change-description">{change.description}</p>
                <details className="ramble-change-details">
                  <summary>View content</summary>
                  <pre className="ramble-change-content">{change.newContent}</pre>
                  <p className="ramble-change-reasoning"><strong>Reasoning:</strong> {change.reasoning}</p>
                </details>
              </div>
            ))}
          </div>
        </div>

        <div className="ramble-modal-actions">
          <button
            className="ramble-modal-btn ramble-modal-btn-secondary"
            onClick={onCancel}
            disabled={isProcessing}
          >
            Cancel
          </button>
          <button
            className="ramble-modal-btn ramble-modal-btn-primary"
            onClick={onApply}
            disabled={isProcessing}
          >
            {isProcessing ? 'Applying...' : 'Apply All'}
          </button>
        </div>
      </div>
    </div>
  );
};
