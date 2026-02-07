import { Trigger, TriggerResult } from '../../types';
import { triggerExecutor } from './executor';

export interface TriggerSchedulerCallbacks {
  getTriggers: () => Trigger[];
  reloadTrigger: (id: string) => Promise<Trigger | null>;
  onTriggerFired: (trigger: Trigger, result: TriggerResult) => Promise<void>;
  onTriggerSkipped: (trigger: Trigger, result: TriggerResult) => void;
  onTriggerChecking: (triggerId: string) => void;
  onTriggerCheckComplete: (triggerId: string) => void;
  onError: (trigger: Trigger, error: Error) => void;
}

// Use a global key to track the interval across HMR reloads
const INTERVAL_KEY = '__triggerSchedulerIntervalId__';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getWindow = (): any => window;

export class TriggerScheduler {
  private checkIntervalMs = 60000; // Check every minute
  private activeChecks = new Set<string>();
  private isRunning = false;
  private callbacks: TriggerSchedulerCallbacks | null = null;

  start(callbacks: TriggerSchedulerCallbacks): void {
    // Clean up any orphaned interval from HMR
    const existingIntervalId = getWindow()[INTERVAL_KEY] as number | undefined;
    if (existingIntervalId) {
      window.clearInterval(existingIntervalId);
      delete getWindow()[INTERVAL_KEY];
    }

    if (this.isRunning) {
      return;
    }

    this.callbacks = callbacks;
    this.isRunning = true;

    console.log('TriggerScheduler: Started');

    // Don't run initial check - wait for the first interval to avoid
    // firing triggers on app reload/refresh
    const intervalId = window.setInterval(() => {
      this.runScheduledChecks();
    }, this.checkIntervalMs);

    // Store on window to survive HMR
    getWindow()[INTERVAL_KEY] = intervalId;
  }

  stop(): void {
    const intervalId = getWindow()[INTERVAL_KEY] as number | undefined;
    if (intervalId) {
      window.clearInterval(intervalId);
      delete getWindow()[INTERVAL_KEY];
    }
    this.isRunning = false;
    this.callbacks = null;
    console.log('TriggerScheduler: Stopped');
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getActiveChecks(): string[] {
    return Array.from(this.activeChecks);
  }

  /**
   * Manually trigger a check for a specific trigger (for testing/debugging)
   */
  async manualCheck(trigger: Trigger): Promise<TriggerResult | null> {
    if (!trigger.enabled) {
      return null;
    }
    return this.checkTrigger(trigger);
  }

  private async runScheduledChecks(): Promise<void> {
    if (!this.callbacks) return;

    const triggers = this.callbacks.getTriggers();
    const enabledTriggers = triggers.filter((t) => t.enabled);

    for (const trigger of enabledTriggers) {
      // Skip if already checking
      if (this.activeChecks.has(trigger.id)) {
        console.log(`TriggerScheduler: Skipping ${trigger.id}, LLM check already in progress`);
        continue;
      }

      // Reload from disk to get latest timestamps (multi-instance coordination)
      const freshTrigger = await this.callbacks.reloadTrigger(trigger.id);
      if (!freshTrigger?.enabled) continue;

      if (!this.isDueForCheck(freshTrigger)) {
        continue;
      }

      // Don't await - run checks concurrently
      this.checkTrigger(freshTrigger);
    }
  }

  private async checkTrigger(trigger: Trigger): Promise<TriggerResult> {
    this.activeChecks.add(trigger.id);
    this.callbacks?.onTriggerChecking(trigger.id);

    try {
      console.log(`TriggerScheduler: Executing LLM check for "${trigger.title}"`);

      // Executor now takes the full trigger object
      const result = await triggerExecutor.executeTrigger(trigger);

      if (result.result === 'triggered') {
        console.log(
          `TriggerScheduler: LLM returned TRIGGERED for "${trigger.title}"`
        );
        await this.callbacks?.onTriggerFired(trigger, result);
      } else if (result.result === 'skipped') {
        console.log(
          `TriggerScheduler: LLM returned SKIPPED for "${trigger.title}": ${result.response}`
        );
        await this.callbacks?.onTriggerSkipped(trigger, result);
      } else {
        // result.result === 'error'
        console.error(
          `TriggerScheduler: LLM check failed for "${trigger.title}": ${result.error}`
        );
        this.callbacks?.onError(trigger, new Error(result.error || 'Unknown error'));
      }

      return result;
    } catch (error) {
      console.error(`TriggerScheduler: LLM check error for "${trigger.title}":`, error);
      this.callbacks?.onError(trigger, error instanceof Error ? error : new Error('Unknown error'));

      return {
        result: 'error',
        response: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.activeChecks.delete(trigger.id);
      this.callbacks?.onTriggerCheckComplete(trigger.id);
    }
  }

  private isDueForCheck(trigger: Trigger): boolean {
    if (!trigger.lastChecked) {
      return true;
    }

    const lastCheck = new Date(trigger.lastChecked);
    const now = new Date();
    const elapsedMs = now.getTime() - lastCheck.getTime();
    const intervalMs = trigger.intervalMinutes * 60 * 1000;

    return elapsedMs >= intervalMs;
  }
}

export const triggerScheduler = new TriggerScheduler();
