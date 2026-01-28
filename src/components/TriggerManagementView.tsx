import { useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { Trigger } from '../types';
import { vaultService } from '../services/vault';
import { useTriggerContext } from '../contexts/TriggerContext';
import './TriggerManagementView.css';

interface TriggerManagementViewProps {
  triggers: Trigger[];
  onNewTrigger: () => void;
  onEditTrigger: (trigger: Trigger) => void;
  onDeleteTrigger: (triggerId: string) => void;
  onSelectTrigger: (triggerId: string) => void;
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes === 60) return 'Every hour';
  if (minutes < 1440) return `Every ${minutes / 60} hours`;
  return 'Every day';
}

function formatTimeAgo(isoString?: string): string {
  if (!isoString) return 'Never';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

export function TriggerManagementView({
  triggers,
  onNewTrigger,
  onEditTrigger,
  onDeleteTrigger,
  onSelectTrigger,
}: TriggerManagementViewProps) {
  const { activeChecks } = useTriggerContext();
  const [runningTriggers, setRunningTriggers] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleViewYaml = async (triggerId: string) => {
    try {
      const vaultPath = vaultService.getVaultPath();
      if (vaultPath) {
        const { join } = await import('@tauri-apps/api/path');
        const filePath = await join(vaultPath, 'triggers', `${triggerId}.yaml`);
        await openPath(filePath);
      }
    } catch (error) {
      console.error('Failed to open trigger file:', error);
    }
  };

  const handleRunNow = async (trigger: Trigger) => {
    setRunningTriggers(prev => new Set(prev).add(trigger.id));

    try {
      const { triggerScheduler } = await import('../services/triggers/scheduler');
      // Cast trigger to Conversation-like shape for scheduler compatibility
      await triggerScheduler.manualCheck(trigger as any);
    } catch (error) {
      console.error('Failed to run trigger:', error);
    } finally {
      setRunningTriggers(prev => {
        const next = new Set(prev);
        next.delete(trigger.id);
        return next;
      });
    }
  };

  const handleDelete = (triggerId: string) => {
    onDeleteTrigger(triggerId);
    setDeleteConfirmId(null);
  };

  return (
    <div className="trigger-management-view">
      <div className="trigger-management-view-header">
        <h2>Manage Triggers</h2>
        <button className="btn-primary" onClick={onNewTrigger}>
          + New Trigger
        </button>
      </div>

      <div className="trigger-management-view-content">
        {triggers.length === 0 ? (
          <div className="no-triggers">
            <p>No triggers configured yet.</p>
            <p className="hint">Triggers automatically run prompts on a schedule.</p>
          </div>
        ) : (
          <div className="trigger-list">
            {triggers.map(trigger => {
              const triggerConfig = trigger.trigger;
              const isRunning = runningTriggers.has(trigger.id) || activeChecks.includes(trigger.id);
              const isDeleting = deleteConfirmId === trigger.id;
              const hasFired = triggerConfig.lastTriggered !== undefined;

              return (
                <div key={trigger.id} className="trigger-item">
                  <div className="trigger-item-header">
                    <span
                      className={`trigger-name ${hasFired ? 'clickable' : ''}`}
                      onClick={() => hasFired && onSelectTrigger(trigger.id)}
                      title={hasFired ? 'View trigger history' : 'Not yet triggered'}
                    >
                      {trigger.title || 'Untitled'}
                    </span>
                    <span className={`trigger-status ${triggerConfig.enabled ? 'enabled' : 'disabled'}`}>
                      {triggerConfig.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <span className="trigger-interval">{formatInterval(triggerConfig.intervalMinutes)}</span>
                  </div>
                  <div className="trigger-item-meta">
                    <span>Last checked: {formatTimeAgo(triggerConfig.lastChecked)}</span>
                    <span>Last triggered: {formatTimeAgo(triggerConfig.lastTriggered)}</span>
                  </div>
                  <div className="trigger-item-actions">
                    <button
                      className="btn-small"
                      onClick={() => onEditTrigger(trigger)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-small"
                      onClick={() => handleViewYaml(trigger.id)}
                    >
                      View YAML
                    </button>
                    {isDeleting ? (
                      <>
                        <button
                          className="btn-small btn-danger"
                          onClick={() => handleDelete(trigger.id)}
                        >
                          Confirm
                        </button>
                        <button
                          className="btn-small"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn-small"
                        onClick={() => setDeleteConfirmId(trigger.id)}
                      >
                        Delete
                      </button>
                    )}
                    <button
                      className="btn-small btn-accent"
                      onClick={() => handleRunNow(trigger)}
                      disabled={isRunning}
                    >
                      {isRunning ? 'Running...' : 'Run Now'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
