import { useMemo, useState } from 'react';
import { ScheduledTask, ModelInfo } from '../types';
import { vaultService } from '../services/vault';
import { useTaskContext } from '../contexts/TaskContext';
import { getApiBase, getAuthHeadersForApi } from '../services/server-streaming';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import { describeTaskSchedule } from '../utils/taskSchedule';
import { providerLabel, isLocalModel } from '../utils/models';
import './TaskDetailView.css';

interface TaskDetailViewProps {
  task: ScheduledTask;
  availableModels: ModelInfo[];
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

// Small padlock marking an on-device (local) model, matching the picker badge.
function LocalLockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" fill="currentColor" />
      <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

// js-yaml's default schema parses ISO timestamps into Date objects, so a run's
// `timestamp` may be a Date or a string at runtime. Normalize to a stable string
// so it works as a Map key / accordion key (Date instances never match by ===).
function tsKey(timestamp: unknown): string {
  return timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function resultLabel(result: string): string {
  return result === 'completed' ? 'Completed'
    : result === 'triggered' ? 'Triggered'
    : result === 'skipped' ? 'Skipped' : 'Error';
}

// One-line plain-text gist of a run's output for the collapsed row: first
// non-empty line, stripped of leading markdown markers and inline formatting.
function oneLineSummary(text: string): string {
  const first = text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  return first
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map of delivered content (assistant messages) keyed by normalized timestamp,
// used to render a run's full output and to pick the default-open entry.
function deliveredMap(task: ScheduledTask): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of task.messages ?? []) {
    if (message.role === 'assistant') map.set(tsKey(message.timestamp), message.content);
  }
  return map;
}

export function TaskDetailView({
  task,
  availableModels,
  onDelete,
  onRunComplete,
  onAskAbout,
  onTaskUpdated,
  onBack,
  canGoBack = false,
  onClose,
}: TaskDetailViewProps) {
  const modelInfo = availableModels.find(m => m.key === task.model);
  const modelName = modelInfo?.name ?? (task.model.split('/').slice(1).join('/') || task.model);
  const modelProvider = providerLabel(modelInfo?.provider, task.model);
  const modelIsLocal = isLocalModel(task.model, availableModels);
  // Unknown = not in the reachable list AND not a known-local provider (mlx is
  // expected to be offline sometimes, so don't flag it Unavailable).
  const modelIsKnown = modelInfo !== undefined || modelIsLocal;
  const { activeRuns, markRunning, markDone } = useTaskContext();
  const [isRunning, setIsRunning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const schedule = useMemo(() => describeTaskSchedule(task), [task]);
  const isChecking = activeRuns.includes(task.id) || isRunning;

  const deliveredByTimestamp = useMemo(() => deliveredMap(task), [task]);
  const history = task.history ?? [];
  const hasDelivered = deliveredByTimestamp.size > 0;

  // Default-open the newest delivered run (the "latest result"), falling back to
  // the newest run overall. Reactive (not a mount-time snapshot) so it lands on
  // the right entry once the task's history/messages hydrate.
  const defaultOpenKey = useMemo<string | null>(() => {
    for (let i = 0; i < history.length; i++) {
      if (deliveredByTimestamp.has(tsKey(history[i].timestamp))) {
        return `${tsKey(history[i].timestamp)}-${i}`;
      }
    }
    return history.length ? `${tsKey(history[0].timestamp)}-0` : null;
  }, [history, deliveredByTimestamp]);

  // `undefined` = user hasn't touched the accordion yet → use the default.
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const expandedKey = override !== undefined ? override : defaultOpenKey;

  const totalCost = useMemo(() => {
    let cost = 0;
    let counted = 0;
    const countedTimestamps = new Set<string>();
    for (const attempt of task.history ?? []) {
      if (attempt.usage?.cost !== undefined) {
        cost += attempt.usage.cost;
        counted++;
        countedTimestamps.add(tsKey(attempt.timestamp));
      }
    }
    for (const message of task.messages ?? []) {
      if (message.role === 'assistant' && message.usage?.cost !== undefined && !countedTimestamps.has(tsKey(message.timestamp))) {
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

  // Accordion: open this run (collapsing any other), or close it if already open.
  const toggleRunExpanded = (key: string) => {
    setOverride(prev => {
      const current = prev !== undefined ? prev : defaultOpenKey;
      return current === key ? null : key;
    });
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
        {/* 1 — Run history: an accordion of every run, latest result open by default */}
        <section className="task-history-section">
          <div className="section-header">
            <div className="section-header-group">
              <h3>Run history</h3>
              {history.length > 0 && <span className="history-count">{history.length}</span>}
            </div>
            <div className="section-header-group">
              {totalCost !== undefined && <span className="task-total-cost">Total: ${formatCost(totalCost)}</span>}
              {hasDelivered && (
                <button className="btn-ask-about-inline" onClick={() => onAskAbout(task)}>Ask about this</button>
              )}
            </div>
          </div>

          {history.length > 0 ? (
            <div className="task-history-list">
              {history.slice(0, 50).map((attempt, index) => {
                const key = `${tsKey(attempt.timestamp)}-${index}`;
                const deliveredContent = deliveredByTimestamp.get(tsKey(attempt.timestamp));
                const detail = attempt.error || attempt.reasoning;
                // The run's "output": the delivered result if it was delivered,
                // otherwise the skip/error reasoning.
                const output = (deliveredContent ?? detail ?? '').trim();
                const isExpanded = expandedKey === key;
                return (
                  <div key={key} className={`history-entry ${attempt.result} ${isExpanded ? 'expanded' : ''}`}>
                    <button
                      className="history-entry-header"
                      onClick={() => toggleRunExpanded(key)}
                      aria-expanded={isExpanded}
                    >
                      <svg
                        className={`disclosure-chevron sm ${isExpanded ? 'open' : ''}`}
                        width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                        aria-hidden="true"
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                      <span className="history-time">{formatDate(attempt.timestamp)}</span>
                      <span className={`history-result ${attempt.result}`}>{resultLabel(attempt.result)}</span>
                      <span className="history-summary">{oneLineSummary(output)}</span>
                    </button>
                    <div className="history-entry-expand">
                      <div className="history-entry-expand-inner">
                        <MarkdownContent content={output} className="history-delivered-content" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="no-response">
              <p>No runs yet.</p>
              <p className="no-response-hint">
                {task.enabled ? 'The task has not run yet — use “Run now” or wait for the next scheduled run.' : 'This task is disabled.'}
              </p>
            </div>
          )}
        </section>

        {/* 2 — Task details: prompt, schedule, delivery condition */}
        <section className="task-schedule-section">
          <div className="section-header">
            <h3>Task details</h3>
          </div>
          <div className="task-model-row">
            <span className="task-field-label">Model</span>
            <div className="task-model-value">
              <span className="task-model-name" title={task.model}>{modelName}</span>
              {modelIsLocal ? (
                <span className="task-model-tag local" title="Runs on a local model — prompts stay on your device">
                  <LocalLockIcon /> Local
                </span>
              ) : (
                <span className="task-model-tag cloud" title={`Runs on ${modelProvider} (cloud)`}>Cloud</span>
              )}
              <span className="task-model-provider">{modelProvider}</span>
              {!modelIsKnown && (
                <span className="task-model-tag unknown" title="This model isn't in the current model list">Unavailable</span>
              )}
            </div>
          </div>
          <div className="task-instructions">
            <div>
              <span className="task-field-label">Prompt</span>
              <p>{task.prompt}</p>
            </div>
            {task.trigger && (
              <div className="task-condition">
                <span className="task-field-label">Deliver when</span>
                <p>{task.trigger.condition}</p>
              </div>
            )}
          </div>
          <div className={`task-schedule-card ${schedule.invalid ? 'invalid' : ''}`}>
            <div className="task-schedule-card-header">
              <div className="task-schedule-description">{schedule.description}</div>
              <span className={`task-kind ${task.trigger ? 'conditional' : 'recurring'}`}>
                {task.trigger ? 'Conditional' : 'Every run'}
              </span>
            </div>
            <div className="task-schedule-technical">
              <span>{schedule.timezone}</span>
              <span aria-hidden="true">·</span>
              <code>{schedule.raw}</code>
            </div>
            {schedule.nextRun && (
              <div className="task-next-run"><span>Next</span>{schedule.nextRun}</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
