import { Message, ProviderType, Trigger, TriggerResult } from '../../types';
import { providerRegistry } from '../providers/registry';
import { executeWithTools, buildSystemPromptWithSkills } from '../tools/executor';
import { truncateToTokenBudget } from '../context';

// Max tokens for trigger context (baseline + prompt). Keeps costs low and focus high.
const MAX_TRIGGER_CONTEXT_TOKENS = 4000;

// Reserve tokens for system prompt, tool results buffer, and trigger prompt
const RESERVED_TOKENS = 1500;

// Max tokens available for baseline content
const MAX_BASELINE_TOKENS = MAX_TRIGGER_CONTEXT_TOKENS - RESERVED_TOKENS;

/**
 * Parse a "provider/model" string into its components.
 * Throws if the format is invalid.
 */
function parseModelString(modelString: string): { provider: ProviderType; model: string } {
  const slashIndex = modelString.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid model format: "${modelString}". Expected "provider/model-id".`);
  }
  const provider = modelString.slice(0, slashIndex) as ProviderType;
  const model = modelString.slice(slashIndex + 1);
  return { provider, model };
}

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

    // Find the assistant message from when the trigger last fired
    // The message timestamp should match lastTriggered
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
  async executeBaselineCheck(trigger: Trigger): Promise<TriggerResult> {
    const modelString = trigger.model || 'anthropic/claude-haiku-4-5-20251001';
    const { provider: providerType, model: modelId } = parseModelString(modelString);
    const provider = providerRegistry.getProvider(providerType);
    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${providerType} is not available`);
    }

    const messages: Message[] = [{
      role: 'user',
      timestamp: new Date().toISOString(),
      content: trigger.triggerPrompt,
    }];

    const systemPrompt = buildSystemPromptWithSkills(buildBaselineSystemPrompt());

    const result = await executeWithTools(provider, messages, modelId, {
      maxIterations: 10,
      systemPrompt,
    });

    return this.parseResponse(result.finalContent);
  }

  /**
   * Execute the trigger: evaluate condition and produce response.
   * Baseline is inferred from conversation history based on lastTriggered.
   */
  async executeTrigger(
    trigger: Trigger
  ): Promise<TriggerResult> {
    // Use trigger's model, falling back to Haiku 4.5 if missing
    const modelString = trigger.model || 'anthropic/claude-haiku-4-5-20251001';
    const { provider: providerType, model: modelId } = parseModelString(modelString);
    const provider = providerRegistry.getProvider(providerType);
    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${providerType} is not available`);
    }

    // Extract baseline from trigger's messages
    const conversationMessages = trigger.messages.filter(m => m.role !== 'log');
    const baseline = this.extractBaseline(trigger, conversationMessages);

    const messages: Message[] = [];

    // Add baseline context if it exists (truncated to stay within token budget)
    if (baseline) {
      const truncatedBaseline = truncateToTokenBudget(baseline, MAX_BASELINE_TOKENS);
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

    // Add the trigger prompt
    messages.push({
      role: 'user',
      timestamp: new Date().toISOString(),
      content: trigger.triggerPrompt,
    });

    // Build system prompt with skills included
    const systemPrompt = buildSystemPromptWithSkills(buildTriggerSystemPrompt());

    // Execute with tool support
    const result = await executeWithTools(provider, messages, modelId, {
      maxIterations: 10,
      systemPrompt,
    });

    return this.parseResponse(result.finalContent);
  }

  /**
   * Parse the response, extracting the JSON verdict and the content.
   */
  private parseResponse(content: string): TriggerResult {
    try {
      // Extract JSON from the end of the response
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
        // Extract content before the JSON block (the actual response)
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
