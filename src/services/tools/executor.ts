import { Message, ToolUse, SkillUse } from '../../types';
import { ToolCall, ToolDefinition, BUILTIN_TOOLS } from '../../types/tools';
import { ToolRound, IProviderService, ChatOptions } from '../providers/types';
import { toolRegistry } from './registry';
import { skillRegistry } from '../skills/registry';
import { ContextManager } from '../context';

export interface ToolExecutionOptions {
  maxIterations?: number;  // Default: 10 for chat, 5 for triggers
  onChunk?: (text: string) => void;
  onToolUse?: (toolUse: ToolUse) => void;
  signal?: AbortSignal;
  imageLoader?: (relativePath: string) => Promise<string>;
  tools?: ToolDefinition[];  // Override default tools
  systemPrompt?: string;
}

export interface ToolExecutionResult {
  finalContent: string;
  allToolUses: ToolUse[];
  skillUses: SkillUse[];
  iterations: number;
}

/**
 * Execute a message with full tool loop support.
 * This handles multi-turn tool use until the model stops calling tools.
 */
export async function executeWithTools(
  provider: IProviderService,
  messages: Message[],
  model: string,
  options: ToolExecutionOptions = {}
): Promise<ToolExecutionResult> {
  const {
    maxIterations = 10,
    onChunk,
    onToolUse,
    signal,
    imageLoader,
    tools = BUILTIN_TOOLS,
    systemPrompt,
  } = options;

  const toolHistory: ToolRound[] = [];
  let allToolUses: ToolUse[] = [];
  const skillUses: SkillUse[] = [];

  const chatOptions: ChatOptions = {
    model,
    systemPrompt,
    tools,
    onChunk,
    onToolUse: (toolUse: ToolUse) => {
      onToolUse?.(toolUse);
    },
    signal,
    imageLoader,
  };

  // Apply context management - build from newest to oldest to fit budget
  const contextManager = new ContextManager();
  const budget = contextManager.calculateBudget(systemPrompt || '', tools);
  const prepared = contextManager.prepareContext(messages, budget);

  if (prepared.truncated) {
    console.log(
      `[Context] Dropped ${prepared.truncatedCount} old messages to fit ${budget.messages} token budget ` +
      `(${prepared.estimatedTokens} tokens used)`
    );
  }

  // Initial request with context-managed messages
  let result = await provider.sendMessage(prepared.messages, chatOptions);
  let finalContent = result.content;
  if (result.toolUse) {
    allToolUses = [...allToolUses, ...result.toolUse];
  }

  // Tool execution loop - keep going while model wants to use tools
  let iteration = 0;
  const providerWithTools = provider as any;

  while (
    iteration < maxIterations &&
    result.stopReason === 'tool_use' &&
    result.toolCalls &&
    result.toolCalls.length > 0 &&
    providerWithTools.sendMessageWithToolResults
  ) {
    iteration++;

    // Check for use_skill tool calls and track them
    for (const toolCall of result.toolCalls) {
      if (toolCall.name === 'use_skill') {
        const skillName = toolCall.input.name as string;
        if (skillName && !skillUses.find(s => s.name === skillName)) {
          skillUses.push({ name: skillName });
        }
      }
    }

    // Execute each tool call
    const toolResults = await Promise.all(
      result.toolCalls.map(async (toolCall: ToolCall) => {
        const toolResult = await toolRegistry.executeTool(toolCall);

        // Update the tool use entry with result (but not for use_skill - we don't show instructions)
        if (toolCall.name !== 'use_skill') {
          const toolUseEntry = allToolUses.find(
            (t) => t.type === toolCall.name && !t.result
          );
          if (toolUseEntry) {
            toolUseEntry.result = toolResult.content.slice(0, 500); // Truncate for display
            toolUseEntry.isError = toolResult.is_error;
          }
        }

        return toolResult;
      })
    );

    // Add this round to the tool history (include any text content from the assistant)
    toolHistory.push({
      textContent: result.content || undefined,
      toolCalls: result.toolCalls,
      toolResults,
    });

    // Add space separator between tool call thoughts
    onChunk?.(' ');

    // Send tool results back to the provider with full history
    result = await providerWithTools.sendMessageWithToolResults(
      prepared.messages,
      toolHistory,
      chatOptions
    );

    finalContent = result.content;
    if (result.toolUse) {
      allToolUses = [...allToolUses, ...result.toolUse];
    }
  }

  // Filter out use_skill from displayed tool uses (it's shown via skillUses instead)
  const displayedToolUses = allToolUses.filter(t => t.type !== 'use_skill');

  return {
    finalContent,
    allToolUses: displayedToolUses,
    skillUses,
    iterations: iteration,
  };
}

/**
 * Build a system prompt with skill information included.
 * Useful for triggers that need access to skills.
 */
export function buildSystemPromptWithSkills(basePrompt?: string, conversationContext?: { id: string; title?: string }): string {
  return skillRegistry.buildSystemPrompt(conversationContext) + (basePrompt ? `\n\n${basePrompt}` : '');
}
