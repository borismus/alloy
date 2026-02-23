import { useState } from 'react';
import { Trigger, Usage } from '../types';
import { vaultService } from '../services/vault';
import { useTriggerContext } from '../contexts/TriggerContext';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import './TriggerDetailView.css';

interface TriggerDetailViewProps {
  trigger: Trigger;
  onDelete: () => void;
  onRunNow: () => void;
  onAskAbout: (trigger: Trigger) => void;
  onTriggerUpdated: (trigger: Trigger) => void;
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
}

function formatUsage(usage: Usage): string {
  const parts: string[] = [];
  if (usage.cost !== undefined) {
    parts.push(`$${formatCost(usage.cost)}`);
  }
  parts.push(`${((usage.inputTokens + usage.outputTokens) / 1000).toFixed(1)}k tok`);
  return parts.join(' · ');
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
  onDelete,
  onRunNow,
  onAskAbout,
  onTriggerUpdated,
  onBack,
  canGoBack = false,
  onClose,
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

  // Compute total cost from history entries + fallback to messages for legacy data
  const totalCost = (() => {
    let cost = 0;
    let counted = 0;
    const countedTimestamps = new Set<string>();

    // Primary: sum from history entries that have usage
    if (trigger.history) {
      for (const attempt of trigger.history) {
        if (attempt.usage?.cost !== undefined) {
          cost += attempt.usage.cost;
          counted++;
          countedTimestamps.add(attempt.timestamp);
        }
      }
    }

    // Fallback: for legacy triggers, sum from assistant messages not already counted
    if (trigger.messages) {
      for (const msg of trigger.messages) {
        if (msg.role === 'assistant' && msg.usage?.cost !== undefined && !countedTimestamps.has(msg.timestamp)) {
          cost += msg.usage.cost;
          counted++;
        }
      }
    }

    return counted > 0 ? cost : undefined;
  })();

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
        onClose={onClose}
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
              {latestResponse.usage && (
                <div className="trigger-usage-badge">
                  {formatUsage(latestResponse.usage)}
                </div>
              )}
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
            <div className="history-section-header">
              <h3>History</h3>
              {totalCost !== undefined && (
                <span className="trigger-total-cost">Total: ${formatCost(totalCost)}</span>
              )}
            </div>
            <div className="trigger-history-list">
              {trigger.history.slice(0, 50).map((attempt, index) => (
                <div key={index} className={`history-entry ${attempt.result}`}>
                  <div className="history-entry-header">
                    <span className="history-time">{formatDate(attempt.timestamp)}</span>
                    <div className="history-entry-meta">
                      {attempt.usage?.cost !== undefined && (
                        <span className="history-cost">${formatCost(attempt.usage.cost)}</span>
                      )}
                      <span className={`history-result ${attempt.result}`}>
                        {attempt.result === 'triggered' ? 'Triggered' :
                         attempt.result === 'skipped' ? 'Skipped' : 'Error'}
                      </span>
                    </div>
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
