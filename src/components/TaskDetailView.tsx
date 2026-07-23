import { useCallback, useMemo, useState } from 'react';
import * as yaml from 'js-yaml';
import { ScheduledTask, ModelInfo } from '../types';
import { vaultService } from '../services/vault';
import { useTaskContext } from '../contexts/TaskContext';
import { getApiBase, getAuthHeadersForApi } from '../services/server-streaming';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import { AiEditPanel } from './AiEditPanel';
import { describeTaskSchedule, parseTaskCron } from '../utils/taskSchedule';
import { providerLabel, isLocalModel } from '../utils/models';
import './TaskDetailView.css';

// The editable config subset shown/diffed in the AI edit composer. Run history,
// ids, timestamps and delivered messages are deliberately excluded so the model
// can't touch them.
function taskEditPrompt(currentConfig: string): string {
  return `You are editing a scheduled task's configuration based on the user's instruction.

CURRENT CONFIG (YAML):
${currentConfig}

Return YAML for the updated config. You may return only the fields that change — any field you omit keeps its current value.

FIELDS:
- title: short human label (string)
- model: the model that runs the task, in "provider/model-id" form (string)
- enabled: whether the task runs (boolean)
- email: whether delivered results are emailed (boolean). Set false to stop emailing.
- prompt: the instruction the task runs on each schedule (string)
- schedule.cron: standard 5-field cron expression (string)
- schedule.timezone: IANA timezone, e.g. "America/New_York" (string)
- trigger.condition: optional delivery gate — results are surfaced only when this natural-language condition is met. Set "trigger: null" to remove it and deliver every run.

RULES:
- Return ONLY valid YAML — no code fences, no commentary.
- When changing the schedule, output a valid cron expression that matches the request.`;
}

// Fields the AI composer may change, in a stable key order for a clean diff.
function taskConfigSubset(task: ScheduledTask): Record<string, unknown> {
  const subset: Record<string, unknown> = {
    title: task.title,
    model: task.model,
    enabled: task.enabled,
  };
  if (task.email !== undefined) subset.email = task.email;
  subset.prompt = task.prompt;
  subset.schedule = { cron: task.schedule.cron, timezone: task.schedule.timezone };
  if (task.trigger) subset.trigger = { condition: task.trigger.condition };
  return subset;
}

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
  favoriteModels?: string[];
  onToggleFavorite?: (modelKey: string) => void;
  defaultModel?: string;
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
  favoriteModels,
  onToggleFavorite,
  defaultModel,
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

  // AI edit: diff the editable config subset (as YAML), then merge the confirmed
  // values back into the fresh task, preserving history/messages/ids.
  const getTaskConfig = useCallback(
    () => yaml.dump(taskConfigSubset(task), { lineWidth: -1 }),
    [task],
  );
  // The model may return only the fields that change; merge its (possibly
  // partial) patch onto the current config to get the resolved full config.
  // This is what we BOTH diff against and apply, so the two never disagree.
  const resolveTaskConfig = useCallback((raw: string): string => {
    const current = taskConfigSubset(task);
    let patch: Record<string, unknown> = {};
    try {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') patch = parsed as Record<string, unknown>;
    } catch {
      // Unparseable output → empty patch → diff shows no change.
    }

    const curSchedule = current.schedule as { cron: string; timezone: string };
    const patchSchedule = (patch.schedule as { cron?: unknown; timezone?: unknown }) ?? {};

    // Build in canonical key order for a stable, minimal diff.
    const merged: Record<string, unknown> = {
      title: typeof patch.title === 'string' ? patch.title : current.title,
      model: typeof patch.model === 'string' ? patch.model : current.model,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    };
    // email: an explicit boolean sets it; `null` removes it; absent keeps current.
    if ('email' in patch) {
      if (typeof patch.email === 'boolean') merged.email = patch.email;
    } else if (current.email !== undefined) {
      merged.email = current.email;
    }
    merged.prompt = typeof patch.prompt === 'string' ? patch.prompt : current.prompt;
    merged.schedule = {
      cron: typeof patchSchedule.cron === 'string' ? patchSchedule.cron : curSchedule.cron,
      timezone: typeof patchSchedule.timezone === 'string' ? patchSchedule.timezone : curSchedule.timezone,
    };
    // trigger: a condition sets it; `null`/absent-condition removes it; absent keeps current.
    if ('trigger' in patch) {
      const cond = (patch.trigger as { condition?: unknown } | null)?.condition;
      if (typeof cond === 'string' && cond.trim()) merged.trigger = { condition: cond.trim() };
    } else if (current.trigger) {
      merged.trigger = current.trigger;
    }
    return yaml.dump(merged, { lineWidth: -1 });
  }, [task]);

  // Receives the already-resolved full config (see resolveTaskConfig).
  const applyTaskEdit = useCallback(async (resolvedYaml: string) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = (yaml.load(resolvedYaml) as Record<string, unknown>) ?? {};
    } catch {
      throw new Error('The proposed config is not valid YAML.');
    }
    if (typeof parsed !== 'object') throw new Error('The proposed config is not valid YAML.');

    const schedule = (parsed.schedule as { cron?: unknown; timezone?: unknown }) ?? {};
    const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : '';
    const timezone = typeof schedule.timezone === 'string' && schedule.timezone.trim()
      ? schedule.timezone.trim()
      : task.schedule.timezone;
    if (!cron) throw new Error('schedule.cron is required.');
    try {
      parseTaskCron(cron, timezone);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Invalid schedule.';
      throw new Error(`Invalid cron expression: "${cron}". ${detail}`);
    }

    const triggerCondition = (parsed.trigger as { condition?: unknown })?.condition;

    const updated = await vaultService.updateTask(task.id, fresh => {
      const next: ScheduledTask = {
        ...fresh,
        title: typeof parsed.title === 'string' ? parsed.title : fresh.title,
        model: typeof parsed.model === 'string' ? parsed.model : fresh.model,
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : fresh.enabled,
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : fresh.prompt,
        schedule: { cron, timezone },
        updated: new Date().toISOString(),
      };
      if (typeof parsed.email === 'boolean') next.email = parsed.email;
      else delete next.email;
      if (typeof triggerCondition === 'string' && triggerCondition.trim()) {
        next.trigger = { condition: triggerCondition.trim() };
      } else {
        delete next.trigger;
      }
      return next;
    });
    if (updated) onTaskUpdated(updated);
  }, [task.id, task.schedule.timezone, onTaskUpdated]);
  const canAiEdit = !!(defaultModel && availableModels.length > 0);

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
        {/* 1 — Config summary: schedule, model, email. Above the run history. */}
        <section className="task-config-section">
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
          <div className="task-model-row">
            <span className="task-field-label">Email</span>
            <div className="task-model-value">
              <span
                className={`task-email-tag ${task.email ? 'on' : 'off'}`}
                title={task.email ? 'Delivered results are emailed via Resend' : 'This task does not send email'}
              >
                {task.email ? 'On' : 'Off'}
              </span>
            </div>
          </div>
          {task.trigger && (
            <div className="task-condition">
              <span className="task-field-label">Deliver when</span>
              <p>{task.trigger.condition}</p>
            </div>
          )}
        </section>

        {/* 2 — Run history: an accordion of every run, latest result open by default */}
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

        {/* 3 — Prompt, at the very bottom. */}
        <section className="task-prompt-section">
          <div className="section-header">
            <h3>Prompt</h3>
          </div>
          <div className="task-instructions">
            <div>
              <p>{task.prompt}</p>
            </div>
          </div>
        </section>
      </div>

      {canAiEdit && (
        <AiEditPanel
          placeholder="Edit this task"
          getCurrentContent={getTaskConfig}
          buildSystemPrompt={taskEditPrompt}
          applyNewContent={applyTaskEdit}
          resolveProposal={resolveTaskConfig}
          defaultModel={defaultModel!}
          availableModels={availableModels}
          favoriteModels={favoriteModels}
          onToggleFavorite={onToggleFavorite}
        />
      )}
    </div>
  );
}
