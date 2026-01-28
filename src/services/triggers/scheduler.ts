import { Conversation, TriggerConfig, TriggerResult } from '../../types';
import { triggerExecutor } from './executor';

export interface TriggerSchedulerCallbacks {
  getConversations: () => Conversation[];
  onTriggerFired: (conversation: Conversation, result: TriggerResult) => Promise<void>;
  onTriggerSkipped: (conversation: Conversation, result: TriggerResult) => void;
  onTriggerChecking: (conversationId: string) => void;
  onTriggerCheckComplete: (conversationId: string) => void;
  onError: (conversation: Conversation, error: Error) => void;
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
   * Manually trigger a check for a specific conversation (for testing/debugging)
   */
  async manualCheck(conversation: Conversation): Promise<TriggerResult | null> {
    if (!conversation.trigger?.enabled) {
      return null;
    }
    return this.checkConversation(conversation);
  }

  private async runScheduledChecks(): Promise<void> {
    if (!this.callbacks) return;

    const conversations = this.callbacks.getConversations();
    const triggeredConversations = conversations.filter(
      (c) => c.trigger?.enabled
    );

    for (const conv of triggeredConversations) {
      const trigger = conv.trigger!;

      if (!this.isDueForCheck(trigger)) {
        continue;
      }

      if (this.activeChecks.has(conv.id)) {
        console.log(`TriggerScheduler: Skipping ${conv.id}, LLM check already in progress`);
        continue;
      }

      // Don't await - run checks concurrently
      this.checkConversation(conv);
    }
  }

  private async checkConversation(conversation: Conversation): Promise<TriggerResult> {
    const trigger = conversation.trigger!;

    this.activeChecks.add(conversation.id);
    this.callbacks?.onTriggerChecking(conversation.id);

    try {
      console.log(`TriggerScheduler: Executing LLM check for "${conversation.title}"`);

      // Pass conversation messages - executor extracts baseline based on triggerConfig.lastTriggered
      const messages = conversation.messages.filter(m => m.role !== 'log');
      const result = await triggerExecutor.executeTrigger(trigger, messages);

      if (result.result === 'triggered') {
        console.log(
          `TriggerScheduler: LLM returned TRIGGERED for "${conversation.title}"`
        );
        await this.callbacks?.onTriggerFired(conversation, result);
      } else if (result.result === 'skipped') {
        console.log(
          `TriggerScheduler: LLM returned SKIPPED for "${conversation.title}": ${result.response}`
        );
        await this.callbacks?.onTriggerSkipped(conversation, result);
      } else {
        // result.result === 'error'
        console.error(
          `TriggerScheduler: LLM check failed for "${conversation.title}": ${result.error}`
        );
        this.callbacks?.onError(conversation, new Error(result.error || 'Unknown error'));
      }

      return result;
    } catch (error) {
      console.error(`TriggerScheduler: LLM check error for "${conversation.title}":`, error);
      this.callbacks?.onError(conversation, error instanceof Error ? error : new Error('Unknown error'));

      return {
        result: 'error',
        response: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.activeChecks.delete(conversation.id);
      this.callbacks?.onTriggerCheckComplete(conversation.id);
    }
  }

  private isDueForCheck(trigger: TriggerConfig): boolean {
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
