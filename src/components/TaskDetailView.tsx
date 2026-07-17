import { useMemo, useState } from 'react';
import { ScheduledTask, Usage } from '../types';
import { vaultService } from '../services/vault';
import { useTaskContext } from '../contexts/TaskContext';
import { getApiBase, getAuthHeadersForApi } from '../services/server-streaming';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import { describeTaskSchedule } from '../utils/taskSchedule';
import './TaskDetailView.css';

interface TaskDetailViewProps {
  task: ScheduledTask;
  onDelete: () => void;
  onRunComplete: () => void;
  onAskAbout: (task: ScheduledTask) => void;
  onTaskUpdated: (task: ScheduledTask) => void;
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
}

function formatUsage(usage: Usage): string {
  const tokens = usage.inputTokens
    + (usage.cachedInputTokens ?? 0)
    + (usage.cacheCreationInputTokens ?? 0)
    + usage.outputTokens;
  const parts = usage.cost === undefined ? [] : [`$${formatCost(usage.cost)}`];
  parts.push(`${(tokens / 1000).toFixed(1)}k tok`);
  return parts.join(' · ');
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function TaskDetailView({
  task,
  onDelete,
  onRunComplete,
  onAskAbout,
  onTaskUpdated,
  onBack,
  canGoBack = false,
  onClose,
}: TaskDetailViewProps) {
  const { activeRuns, markRunning, markDone } = useTaskContext();
  const [isRunning, setIsRunning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const schedule = useMemo(() => describeTaskSchedule(task), [task]);
  const isChecking = activeRuns.includes(task.id) || isRunning;
  const latestResponse = task.messages?.filter(message => message.role === 'assistant').slice(-1)[0];

  const totalCost = useMemo(() => {
    let cost = 0;
    let counted = 0;
    const countedTimestamps = new Set<string>();
    for (const attempt of task.history ?? []) {
      if (attempt.usage?.cost !== undefined) {
        cost += attempt.usage.cost;
        counted++;
        countedTimestamps.add(attempt.timestamp);
      }
    }
    for (const message of task.messages ?? []) {
      if (message.role === 'assistant' && message.usage?.cost !== undefined && !countedTimestamps.has(message.timestamp)) {
        cost += message.usage.cost;
        counted++;
      }
    }
    return counted > 0 ? cost : undefined;
  }, [task.history, task.messages]);

  const handleRunNow = async () => {
    setIsRunning(true);
    markRunning(task.id);
    try {
      const response = await fetch(`${getApiBase()}/api/tasks/${task.id}/run`, {
        method: 'POST',
        headers: getAuthHeadersForApi(),
      });
      if (!response.ok) console.error(`Task run failed: HTTP ${response.status}`);
      onRunComplete();
    } catch (error) {
      console.error('Failed to run task:', error);
    } finally {
      markDone(task.id);
      setIsRunning(false);
    }
  };

  const handleToggleEnabled = async () => {
    setIsToggling(true);
    try {
      const updated = await vaultService.updateTask(task.id, fresh => ({
        ...fresh,
        enabled: !fresh.enabled,
      }));
      if (updated) onTaskUpdated(updated);
    } catch (error) {
      console.error('Failed to toggle task:', error);
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div className="task-detail-view">
      <ItemHeader
        title={task.title || 'Untitled task'}
        onBack={onBack}
        canGoBack={canGoBack}
        onClose={onClose}
      >
        <button className="btn-small btn-accent" onClick={handleRunNow} disabled={isChecking}>
          {isChecking ? 'Running…' : 'Run now'}
        </button>
        <button
          className={`btn-small ${task.enabled ? '' : 'btn-muted'}`}
          onClick={handleToggleEnabled}
          disabled={isToggling}
        >
          {task.enabled ? 'Disable' : 'Enable'}
        </button>
        {showDeleteConfirm ? (
          <>
            <button className="btn-small btn-danger" onClick={() => { onDelete(); setShowDeleteConfirm(false); }}>Confirm</button>
            <button className="btn-small" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn-small" onClick={() => setShowDeleteConfirm(true)}>Delete</button>
        )}
      </ItemHeader>

      <div className="task-detail-content">
        <section className="task-schedule-section">
          <div className="section-header">
            <h3>Schedule</h3>
            <span className={`task-kind ${task.trigger ? 'conditional' : 'recurring'}`}>
              {task.trigger ? 'Conditional' : 'Every run'}
            </span>
          </div>
          <div className={`task-schedule-card ${schedule.invalid ? 'invalid' : ''}`}>
            <div className="task-schedule-description">{schedule.description}</div>
            <div className="task-schedule-technical">
              <span>{schedule.timezone}</span>
              <span aria-hidden="true">·</span>
              <code>{schedule.raw}</code>
            </div>
            {schedule.nextRun && (
              <div className="task-next-run"><span>Next</span>{schedule.nextRun}</div>
            )}
          </div>
          <div className="task-instructions">
            <div>
              <span className="task-field-label">Task</span>
              <p>{task.prompt}</p>
            </div>
            {task.trigger && (
              <div className="task-condition">
                <span className="task-field-label">Deliver when</span>
                <p>{task.trigger.condition}</p>
              </div>
            )}
          </div>
        </section>

        <section className="task-latest-section">
          <div className="section-header">
            <h3>Latest delivered result</h3>
            {latestResponse && <span className="latest-time">{formatDate(latestResponse.timestamp)}</span>}
          </div>
          {latestResponse ? (
            <>
              <MarkdownContent content={latestResponse.content} className="latest-response-content" />
              {latestResponse.usage && <div className="task-usage-badge">{formatUsage(latestResponse.usage)}</div>}
              <button className="btn-ask-about" onClick={() => onAskAbout(task)}>
                Ask about this
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </>
          ) : (
            <div className="no-response">
              <p>No delivered result yet.</p>
              <p className="no-response-hint">
                {task.trigger ? 'The condition has not been met.' : 'The task has not completed its first scheduled run.'}
              </p>
            </div>
          )}
        </section>

        {task.history && task.history.length > 0 && (
          <section className="task-history-section">
            <div className="history-section-header">
              <h3>Run history</h3>
              {totalCost !== undefined && <span className="task-total-cost">Total: ${formatCost(totalCost)}</span>}
            </div>
            <div className="task-history-list">
              {task.history.slice(0, 50).map((attempt, index) => (
                <div key={`${attempt.timestamp}-${index}`} className={`history-entry ${attempt.result}`}>
                  <div className="history-entry-header">
                    <span className="history-time">{formatDate(attempt.timestamp)}</span>
                    <div className="history-entry-meta">
                      {attempt.usage?.cost !== undefined && <span className="history-cost">${formatCost(attempt.usage.cost)}</span>}
                      <span className={`history-result ${attempt.result}`}>
                        {attempt.result === 'completed' ? 'Completed' :
                         attempt.result === 'triggered' ? 'Triggered' :
                         attempt.result === 'skipped' ? 'Skipped' : 'Error'}
                      </span>
                    </div>
                  </div>
                  <div className="history-reasoning">{attempt.error || attempt.reasoning}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
