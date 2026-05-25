import { Message, Trigger, TriggerResult, Usage } from '../../types';
import { executeViaServer } from '../server-streaming';
import { generateMessageId } from '../../utils/ids';

export interface TriggerExecutionResult {
  triggerResult: TriggerResult;
  usage?: Usage;
}

// Max characters of baseline content we'll feed back into the trigger
// prompt. Same intent as the old token-budget cap (~3500 chars ≈ 875
// tokens), just calculated by character count since we no longer have a
// client-side tokenizer.
const MAX_BASELINE_CHARS = 14_000;

function buildBaselineSystemPrompt(): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `You are a trigger evaluation system establishing a baseline for future monitoring.

Current time: ${timeStr} on ${dateStr}
Timezone: ${timezone}

This is a BASELINE ESTABLISHMENT run. Your job is to gather the current state of what's being monitored so that future checks can detect changes.

You have access to tools like web_search to gather real-time information. Use them as needed.

IMPORTANT: Always gather and report the current data. Include specific data points (numbers, prices, percentages, timestamps, etc.) so future checks can detect meaningful changes.

Always end your response with:
\`\`\`json
{"triggered": true}
\`\`\`

Your response will be saved as the baseline for future comparison.`;
}

function buildTriggerSystemPrompt(): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `You are a trigger evaluation system that monitors conditions and notifies the user when they're met.

Current time: ${timeStr} on ${dateStr}
Timezone: ${timezone}

A BASELINE from your last notification is provided below.
The baseline is your last assistant message from when you previously triggered.
Only trigger if the current state has MEANINGFULLY CHANGED from this baseline.
Do NOT re-trigger for the same condition that was already reported.
Compare the current data against the baseline to detect changes.
If no baseline is available, gather the current state and report it — your response will become the baseline for future comparisons.

You have access to tools like web_search to gather real-time information. Use them as needed.

Your response format depends on whether you should trigger:

IF TRIGGERING (condition met / changed meaningfully):
Provide a helpful, informative response to the user about the current state.
Include specific data points (numbers, prices, percentages, etc.) that are relevant.
End your response with a JSON block:
\`\`\`json
{"triggered": true}
\`\`\`

IF NOT TRIGGERING (condition not met / no meaningful change):
End with a JSON block explaining why:
\`\`\`json
{"triggered": false, "reason": "brief explanation"}
\`\`\`

You MUST end with the JSON block. Any text before it will be shown to the user if triggered.`;
}

/**
 * Run the model with full tool support via the embedded alloy-server.
 * `skipPersist` means the server won't try to append to a conversation
 * YAML — triggers live in `triggers/*.yaml`, not `conversations/*.yaml`.
 */
async function runViaServer(
  trigger: Trigger,
  messages: Message[],
  systemPrompt: string,
): Promise<{ content: string; usage?: Usage }> {
  const modelString = trigger.model || 'openrouter/anthropic/claude-haiku-4.5';
  // The conversationId is the trigger id; the skipPersist flag tells the
  // server not to look for a conversation file. executeViaServer
  // internally generates a fresh sessionId per call.
  const result = await executeViaServer(
    trigger.id,
    generateMessageId(),
    modelString,
    messages,
    systemPrompt,
    false,
    trigger.triggerPrompt,
    { skipPersist: true },
  );
  return { content: result.content, usage: result.usage };
}

export class TriggerExecutor {
  /**
   * Extract the baseline from conversation history.
   * The baseline is the assistant response from when the trigger last fired.
   */
  private extractBaseline(
    trigger: Trigger,
    conversationMessages: Message[]
  ): string | undefined {
    if (!trigger.lastTriggered) {
      return undefined;
    }

    const lastTriggeredTime = trigger.lastTriggered;
    const baselineMessage = conversationMessages.find(
      m => m.role === 'assistant' && m.timestamp === lastTriggeredTime
    );

    return baselineMessage?.content;
  }

  /**
   * Run a baseline establishment check for a newly created trigger.
   * Gathers the current state without notifying the user.
   * The response becomes the baseline for future comparisons.
   */
  async executeBaselineCheck(trigger: Trigger): Promise<TriggerExecutionResult> {
    const messages: Message[] = [{
      role: 'user',
      timestamp: new Date().toISOString(),
      content: trigger.triggerPrompt,
    }];

    const { content, usage } = await runViaServer(
      trigger,
      messages,
      buildBaselineSystemPrompt(),
    );
    return { triggerResult: this.parseResponse(content), usage };
  }

  /**
   * Execute the trigger: evaluate condition and produce response.
   * Baseline is inferred from conversation history based on lastTriggered.
   */
  async executeTrigger(trigger: Trigger): Promise<TriggerExecutionResult> {
    const conversationMessages = trigger.messages.filter(m => m.role !== 'log');
    const baseline = this.extractBaseline(trigger, conversationMessages);

    const messages: Message[] = [];

    if (baseline) {
      const truncatedBaseline = baseline.length > MAX_BASELINE_CHARS
        ? baseline.slice(0, MAX_BASELINE_CHARS) + '\n…[truncated]'
        : baseline;
      messages.push({
        role: 'user',
        timestamp: new Date().toISOString(),
        content: `BASELINE (from your last notification):\n\n${truncatedBaseline}`,
      });
      messages.push({
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: 'I will compare the current state against this baseline and only trigger if there is a meaningful change.',
      });
    }

    messages.push({
      role: 'user',
      timestamp: new Date().toISOString(),
      content: trigger.triggerPrompt,
    });

    const { content, usage } = await runViaServer(
      trigger,
      messages,
      buildTriggerSystemPrompt(),
    );
    return { triggerResult: this.parseResponse(content), usage };
  }

  /**
   * Parse the response, extracting the JSON verdict and the content.
   */
  private parseResponse(content: string): TriggerResult {
    try {
      const codeBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/);
      const jsonStr = codeBlockMatch?.[1] || content.match(/\{[^{}]*"triggered"[^{}]*\}\s*$/)?.[0];

      if (!jsonStr) {
        return {
          result: 'error',
          response: '',
          error: `No JSON verdict found in response: "${content.slice(-200)}"`,
        };
      }

      const parsed = JSON.parse(jsonStr);

      if (typeof parsed.triggered !== 'boolean') {
        return {
          result: 'error',
          response: '',
          error: `Invalid response: triggered must be boolean, got "${typeof parsed.triggered}"`,
        };
      }

      if (parsed.triggered) {
        const responseContent = content.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/, '').trim()
          || content.replace(/\{[^{}]*"triggered"[^{}]*\}\s*$/, '').trim();

        return {
          result: 'triggered',
          response: responseContent || 'Condition met.',
        };
      } else {
        return {
          result: 'skipped',
          response: String(parsed.reason || 'Condition not met'),
        };
      }
    } catch (error) {
      return {
        result: 'error',
        response: '',
        error: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

export const triggerExecutor = new TriggerExecutor();
