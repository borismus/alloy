import React from 'react';
import { ProposedChange } from '../types';
import { AlloyDialog } from './ui';
import './RiffBatchApprovalModal.css';

interface RiffBatchApprovalModalProps {
  proposedChanges: ProposedChange[];
  isProcessing: boolean;
  onApply: () => void;
  onCancel: () => void;
}

export const RiffBatchApprovalModal: React.FC<RiffBatchApprovalModalProps> = ({
  proposedChanges,
  isProcessing,
  onApply,
  onCancel,
}) => {
  const isEmpty = proposedChanges.length === 0;

  return (
    <AlloyDialog
      isOpen
      onOpenChange={(open) => { if (!open && !isProcessing) onCancel(); }}
      dismissable={!isProcessing}
      title={isEmpty ? 'Integration Complete' : 'Integrate Insights'}
    >
      {() => (
        <>
          <div className="riff-modal-body">
            {isEmpty ? (
              <p className="riff-modal-empty">No integrations proposed. Your riff has been saved.</p>
            ) : (
              <div className="riff-modal-changes">
                {proposedChanges.map((change, index) => (
                  <div key={index} className="riff-change-item">
                    <div className="riff-change-header">
                      <span className={`riff-change-type riff-change-type-${change.type}`}>
                        {change.type}
                      </span>
                      <span className="riff-change-path">{change.path}</span>
                    </div>
                    <p className="riff-change-description">{change.description}</p>
                    <details className="riff-change-details">
                      <summary>View content</summary>
                      <pre className="riff-change-content">{change.newContent}</pre>
                      <p className="riff-change-reasoning"><strong>Reasoning:</strong> {change.reasoning}</p>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="riff-modal-actions">
            {isEmpty ? (
              <button className="riff-modal-btn riff-modal-btn-primary" onClick={onCancel}>
                Done
              </button>
            ) : (
              <>
                <button
                  className="riff-modal-btn riff-modal-btn-secondary"
                  onClick={onCancel}
                  disabled={isProcessing}
                >
                  Cancel
                </button>
                <button
                  className="riff-modal-btn riff-modal-btn-primary"
                  onClick={onApply}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Applying...' : 'Apply All'}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </AlloyDialog>
  );
};
