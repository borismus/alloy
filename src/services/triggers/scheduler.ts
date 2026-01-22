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

export class TriggerScheduler {
  private intervalId: number | null = null;
  private checkIntervalMs = 60000; // Check every minute
  private activeChecks = new Set<string>();
  private isRunning = false;
  private callbacks: TriggerSchedulerCallbacks | null = null;

  start(callbacks: TriggerSchedulerCallbacks): void {
    if (this.isRunning) {
      console.log('TriggerScheduler: Already running');
      return;
    }

    this.callbacks = callbacks;
    this.isRunning = true;

    console.log('TriggerScheduler: Starting...');

    // Run initial check
    this.runScheduledChecks();

    // Then check every minute
    this.intervalId = window.setInterval(() => {
      this.runScheduledChecks();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
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

    console.log(
      `TriggerScheduler: Checking ${triggeredConversations.length} triggered conversations`
    );

    for (const conv of triggeredConversations) {
      const trigger = conv.trigger!;

      if (!this.isDueForCheck(trigger)) {
        continue;
      }

      if (this.activeChecks.has(conv.id)) {
        console.log(`TriggerScheduler: Skipping ${conv.id}, already checking`);
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
      console.log(`TriggerScheduler: Checking trigger for "${conversation.title}"`);

      // Pass recent conversation history for context (last 2 trigger cycles = 8 messages)
      // Filter out log messages, keep only user/assistant messages
      const recentHistory = conversation.messages
        .filter(m => m.role !== 'log')
        .slice(-8);

      const result = await triggerExecutor.executeTriggerPrompt(trigger, recentHistory);

      if (result.result === 'triggered') {
        console.log(
          `TriggerScheduler: Trigger FIRED for "${conversation.title}": ${result.reasoning}`
        );
        await this.callbacks?.onTriggerFired(conversation, result);
      } else if (result.result === 'skipped') {
        console.log(
          `TriggerScheduler: Trigger skipped for "${conversation.title}": ${result.reasoning}`
        );
        await this.callbacks?.onTriggerSkipped(conversation, result);
      } else {
        // result.result === 'error'
        console.error(
          `TriggerScheduler: Trigger error for "${conversation.title}": ${result.error}`
        );
        this.callbacks?.onError(conversation, new Error(result.error || 'Unknown error'));
      }

      return result;
    } catch (error) {
      console.error(`TriggerScheduler: Error checking "${conversation.title}":`, error);
      this.callbacks?.onError(conversation, error instanceof Error ? error : new Error('Unknown error'));

      return {
        result: 'error',
        reasoning: '',
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
