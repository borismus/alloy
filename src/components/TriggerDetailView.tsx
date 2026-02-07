import { useState } from 'react';
import { Trigger } from '../types';
import { vaultService } from '../services/vault';
import { useTriggerContext } from '../contexts/TriggerContext';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import './TriggerDetailView.css';

interface TriggerDetailViewProps {
  trigger: Trigger;
  onBack: () => void;
  canGoBack?: boolean;
  onDelete: () => void;
  onRunNow: () => void;
  onAskAbout: (trigger: Trigger) => void;
  onTriggerUpdated: (trigger: Trigger) => void;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function TriggerDetailView({
  trigger,
  onBack,
  canGoBack,
  onDelete,
  onRunNow,
  onAskAbout,
  onTriggerUpdated,
}: TriggerDetailViewProps) {
  const { activeChecks } = useTriggerContext();
  const [isRunning, setIsRunning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  const isChecking = activeChecks.includes(trigger.id) || isRunning;

  // Get the latest triggered response (most recent assistant message)
  const latestResponse = trigger.messages
    ?.filter(m => m.role === 'assistant')
    .pop();

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      const { triggerScheduler } = await import('../services/triggers/scheduler');
      await triggerScheduler.manualCheck(trigger as any);
      onRunNow();
    } catch (error) {
      console.error('Failed to run trigger:', error);
    } finally {
      setIsRunning(false);
    }
  };

  const handleToggleEnabled = async () => {
    setIsToggling(true);
    try {
      const updatedTrigger = await vaultService.updateTrigger(trigger.id, (t) => ({
        ...t,
        enabled: !t.enabled,
      }));
      if (updatedTrigger) {
        onTriggerUpdated(updatedTrigger);
      }
    } catch (error) {
      console.error('Failed to toggle trigger:', error);
    } finally {
      setIsToggling(false);
    }
  };

  const handleDelete = () => {
    onDelete();
    setShowDeleteConfirm(false);
  };

  const handleAskAbout = () => {
    onAskAbout(trigger);
  };

  return (
    <div className="trigger-detail-view">
      <ItemHeader
        title={trigger.title || 'Untitled Trigger'}
        onBack={onBack}
        canGoBack={canGoBack}
      >
        <button
          className="btn-small btn-accent"
          onClick={handleRunNow}
          disabled={isChecking}
        >
          {isChecking ? 'Running...' : 'Run Now'}
        </button>
        <button
          className={`btn-small ${trigger.enabled ? '' : 'btn-muted'}`}
          onClick={handleToggleEnabled}
          disabled={isToggling}
        >
          {trigger.enabled ? 'Disable' : 'Enable'}
        </button>
        {showDeleteConfirm ? (
          <>
            <button className="btn-small btn-danger" onClick={handleDelete}>Confirm</button>
            <button className="btn-small" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn-small" onClick={() => setShowDeleteConfirm(true)}>Delete</button>
        )}
      </ItemHeader>

      <div className="trigger-detail-content">
        {/* Latest Response Section - Prominent */}
        <section className="trigger-latest-section">
          <div className="section-header">
            <h3>Latest Response</h3>
            {latestResponse && (
              <span className="latest-time">{formatDate(latestResponse.timestamp)}</span>
            )}
          </div>
          {latestResponse ? (
            <>
              <MarkdownContent
                content={latestResponse.content}
                className="latest-response-content"
              />
              <button className="btn-ask-about" onClick={handleAskAbout}>
                Ask about this
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </>
          ) : (
            <div className="no-response">
              <p>No response yet. This monitor hasn't triggered.</p>
              <p className="no-response-hint">
                Watching for: <em>{trigger.triggerPrompt}</em>
              </p>
            </div>
          )}
        </section>

        {/* History Section */}
        {trigger.history && trigger.history.length > 0 && (
          <section className="trigger-history-section">
            <h3>History</h3>
            <div className="trigger-history-list">
              {trigger.history.slice(0, 50).map((attempt, index) => (
                <div key={index} className={`history-entry ${attempt.result}`}>
                  <div className="history-entry-header">
                    <span className="history-time">{formatDate(attempt.timestamp)}</span>
                    <span className={`history-result ${attempt.result}`}>
                      {attempt.result === 'triggered' ? 'Triggered' :
                       attempt.result === 'skipped' ? 'Skipped' : 'Error'}
                    </span>
                  </div>
                  <div className="history-reasoning">
                    {attempt.error || attempt.reasoning}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
