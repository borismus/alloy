import { Conversation, Message, ProviderType, TriggerConfig, TriggerResult } from '../../types';
import { providerRegistry } from '../providers/registry';
import { executeWithTools, buildSystemPromptWithSkills } from '../tools/executor';

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

function buildTriggerBasePrompt(): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `You are a trigger evaluation system. Evaluate the condition and return your verdict as JSON.

Current time: ${timeStr} on ${dateStr}
Timezone: ${timezone}

You have access to tools like web_search to gather information. Use them when needed.

You may be provided with previous trigger history showing what was found in past checks.
Use this to detect CHANGES - only trigger if the current state differs meaningfully from the last check.

For example:
- "Website changed" → compare current content to what was found last time
- "Odds changed" → compare current odds to previous odds
- "Price dropped" → compare current price to previous price

If no history is provided, this is the first check. You decide whether to trigger based on the prompt's intent:
- For "notify me when X happens" → only trigger if X is currently true
- For "track changes to Y" → you may trigger to establish a baseline, or skip and wait for the next check

After gathering information, respond with a JSON code block containing your verdict:

\`\`\`json
{"shouldTrigger": true, "reasoning": "brief explanation"}
\`\`\`

or

\`\`\`json
{"shouldTrigger": false, "reasoning": "brief explanation"}
\`\`\`

You may include brief analysis before the JSON block, but you MUST end with the JSON block.`;
}

export class TriggerExecutor {
  /**
   * Execute the trigger prompt to determine if the main prompt should run.
   * Uses a cheap model (e.g., Haiku) for cost efficiency.
   * Supports tools and skills for real-time data access.
   * Optionally includes conversation history for change-detection triggers.
   */
  async executeTriggerPrompt(
    triggerConfig: TriggerConfig,
    conversationHistory?: Message[]
  ): Promise<TriggerResult> {
    const { provider: triggerProviderType, model: triggerModelId } = parseModelString(triggerConfig.triggerModel);
    const provider = providerRegistry.getProvider(triggerProviderType);
    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${triggerProviderType} is not available`);
    }

    const messages: Message[] = [];

    // Add recent history as context (if provided)
    if (conversationHistory?.length) {
      const historyText = conversationHistory
        .map(m => `[${m.role}]: ${m.content}`)
        .join('\n\n');

      messages.push({
        role: 'user',
        timestamp: new Date().toISOString(),
        content: `Here is the recent history from previous trigger checks:\n\n${historyText}`,
      });
      messages.push({
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: 'I understand. I will compare the current state to this previous data when evaluating the trigger condition.',
      });
    }

    // Add the actual trigger prompt
    messages.push({
      role: 'user',
      timestamp: new Date().toISOString(),
      content: triggerConfig.triggerPrompt,
    });

    // Build system prompt with skills included (includes current time/timezone)
    const systemPrompt = buildSystemPromptWithSkills(buildTriggerBasePrompt());

    // Execute with tool support (limited iterations for triggers)
    const result = await executeWithTools(provider, messages, triggerModelId, {
      maxIterations: 5,  // Fewer iterations for trigger evaluation
      systemPrompt,
    });

    return this.parseTriggerResponse(result.finalContent);
  }

  /**
   * Execute the main prompt when the trigger fires.
   * Uses an expensive model for quality responses.
   * Supports tools and skills for real-time data access.
   * Returns 4 messages: trigger prompt, trigger reasoning, main prompt, main response
   */
  async executeMainPrompt(
    conversation: Conversation,
    triggerConfig: TriggerConfig,
    triggerReasoning: string,
    onChunk?: (text: string) => void
  ): Promise<{
    triggerPromptMsg: Message;
    triggerReasoningMsg: Message;
    mainPromptMsg: Message;
    mainResponseMsg: Message;
  }> {
    const { provider: mainProviderType, model: mainModelId } = parseModelString(triggerConfig.mainModel);
    const provider = providerRegistry.getProvider(mainProviderType);
    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${mainProviderType} is not available`);
    }

    const now = new Date().toISOString();

    // Create the 4-message block for this trigger firing
    const triggerPromptMsg: Message = {
      role: 'user',
      timestamp: now,
      content: triggerConfig.triggerPrompt,
    };

    const triggerReasoningMsg: Message = {
      role: 'assistant',
      timestamp: now,
      content: triggerReasoning,
      model: triggerConfig.triggerModel,  // Already in "provider/model-id" format
    };

    const mainPromptMsg: Message = {
      role: 'user',
      timestamp: now,
      content: triggerConfig.mainPrompt,
    };

    // Build messages: full history + trigger prompt/reasoning + main prompt
    const messages: Message[] = [
      ...conversation.messages.filter(m => m.role !== 'log'),
      triggerPromptMsg,
      triggerReasoningMsg,
      mainPromptMsg,
    ];

    // Build system prompt with skills included
    const systemPrompt = buildSystemPromptWithSkills();

    // Execute with tool support
    const result = await executeWithTools(provider, messages, mainModelId, {
      maxIterations: 10,
      systemPrompt,
      onChunk,
    });

    const mainResponseMsg: Message = {
      role: 'assistant',
      timestamp: new Date().toISOString(),
      content: result.finalContent,
      model: triggerConfig.mainModel,  // Already in "provider/model-id" format
      toolUse: result.allToolUses.length > 0 ? result.allToolUses : undefined,
      skillUse: result.skillUses.length > 0 ? result.skillUses : undefined,
    };

    return { triggerPromptMsg, triggerReasoningMsg, mainPromptMsg, mainResponseMsg };
  }

  /**
   * Parse the trigger response JSON, handling malformed responses gracefully.
   */
  private parseTriggerResponse(content: string): TriggerResult {
    try {
      // First try to extract JSON from a code block (```json ... ```)
      const codeBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      const jsonStr = codeBlockMatch?.[1] || content.match(/\{[\s\S]*\}/)?.[0];

      if (!jsonStr) {
        return {
          result: 'error',
          reasoning: '',
          error: `No JSON found in response: "${content.slice(0, 100)}"`,
        };
      }

      const parsed = JSON.parse(jsonStr);

      // Validate the structure
      if (typeof parsed.shouldTrigger !== 'boolean') {
        return {
          result: 'error',
          reasoning: '',
          error: `Invalid response: shouldTrigger must be boolean, got "${typeof parsed.shouldTrigger}"`,
        };
      }

      return {
        result: parsed.shouldTrigger ? 'triggered' : 'skipped',
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
      };
    } catch (error) {
      return {
        result: 'error',
        reasoning: '',
        error: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

export const triggerExecutor = new TriggerExecutor();
