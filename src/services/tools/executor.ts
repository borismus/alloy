import { Message, ToolUse, SkillUse, SubagentResponse, parseModelId } from '../../types';
import { ToolCall, ToolDefinition, ToolResult, BUILTIN_TOOLS } from '../../types/tools';
import { ToolRound, IProviderService, ChatOptions } from '../providers/types';
import { toolRegistry, ToolContext } from './registry';
import { skillRegistry } from '../skills/registry';
import { providerRegistry } from '../providers/registry';
import { ContextManager } from '../context';

export interface ApprovalRequest {
  path: string;
  originalContent: string;
  newContent: string;
}

export interface ToolExecutionOptions {
  maxIterations?: number;  // Default: 10 for chat, 5 for triggers
  onChunk?: (text: string) => void;
  onToolUse?: (toolUse: ToolUse) => void;
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean>;  // Returns true if approved
  signal?: AbortSignal;
  imageLoader?: (relativePath: string) => Promise<string>;
  tools?: ToolDefinition[];  // Override default tools
  systemPrompt?: string;
  toolContext?: ToolContext;  // Context passed to tool executors (e.g., messageId for provenance)
  // Sub-agent streaming callbacks
  onSubagentStart?: (agents: { id: string; name: string; model: string; prompt: string }[]) => void;
  onSubagentChunk?: (agentId: string, chunk: string) => void;
  onSubagentToolUse?: (agentId: string, toolUse: ToolUse) => void;
  onSubagentComplete?: (agentId: string, content: string, error?: string) => void;
}

export interface ToolExecutionResult {
  finalContent: string;
  allToolUses: ToolUse[];
  skillUses: SkillUse[];
  iterations: number;
  subagentResponses: SubagentResponse[];
}

/**
 * Execute the spawn_subagent tool: run 1-3 sub-agents in parallel.
 * Returns a tool result with combined output + collected SubagentResponses.
 */
async function executeSubagentTool(
  toolCall: ToolCall,
  parentModel: string,
  options: ToolExecutionOptions,
): Promise<{ toolResult: ToolResult; responses: SubagentResponse[] }> {
  // Parse agents config from JSON string
  let agentConfigs: Array<{ name: string; prompt: string; model?: string; system_prompt?: string }>;
  try {
    const raw = toolCall.input.agents as string;
    agentConfigs = JSON.parse(raw);
    if (!Array.isArray(agentConfigs) || agentConfigs.length === 0) {
      throw new Error('agents must be a non-empty array');
    }
    if (agentConfigs.length > 3) {
      agentConfigs = agentConfigs.slice(0, 3);
    }
  } catch (e) {
    return {
      toolResult: {
        tool_use_id: toolCall.id,
        content: `Failed to parse agents config: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
      },
      responses: [],
    };
  }

  // Validate models against available models
  const availableModels = providerRegistry.getAllAvailableModels();
  const availableModelKeys = new Set(availableModels.map(m => m.key));

  for (const config of agentConfigs) {
    if (config.model && !availableModelKeys.has(config.model)) {
      return {
        toolResult: {
          tool_use_id: toolCall.id,
          content: `Unknown model "${config.model}" for agent "${config.name}". Available models: ${availableModels.map(m => m.key).join(', ')}`,
          is_error: true,
        },
        responses: [],
      };
    }
  }

  const agents = agentConfigs.map((config, i) => ({
    id: `subagent-${Date.now()}-${i}`,
    name: config.name || `Agent ${i + 1}`,
    prompt: config.prompt,
    model: config.model || parentModel,
    systemPrompt: config.system_prompt,
  }));

  // Signal UI
  options.onSubagentStart?.(agents.map(a => ({ id: a.id, name: a.name, model: a.model, prompt: a.prompt })));

  // Tools for sub-agents: everything except spawn_subagent (prevent recursion)
  const subagentTools = BUILTIN_TOOLS.filter(t => t.name !== 'spawn_subagent');

  // Execute all sub-agents in parallel
  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const { provider: providerType, modelId } = parseModelId(agent.model);
      const provider = providerRegistry.getProvider(providerType);
      if (!provider || !provider.isInitialized()) {
        throw new Error(`Provider ${providerType} not available for sub-agent "${agent.name}"`);
      }

      const subMessages: Message[] = [{
        role: 'user' as const,
        timestamp: new Date().toISOString(),
        content: agent.prompt,
      }];

      const subResult = await executeWithTools(provider, subMessages, modelId, {
        maxIterations: 5,
        tools: subagentTools,
        systemPrompt: agent.systemPrompt,
        signal: options.signal,
        imageLoader: options.imageLoader,
        onChunk: (chunk) => options.onSubagentChunk?.(agent.id, chunk),
        onToolUse: (toolUse) => options.onSubagentToolUse?.(agent.id, toolUse),
        toolContext: options.toolContext,
      });

      options.onSubagentComplete?.(agent.id, subResult.finalContent);

      return {
        name: agent.name,
        model: agent.model,
        prompt: agent.prompt,
        content: subResult.finalContent,
        toolUse: subResult.allToolUses.length > 0 ? subResult.allToolUses : undefined,
        skillUse: subResult.skillUses.length > 0 ? subResult.skillUses : undefined,
      } as SubagentResponse;
    })
  );

  // Collect responses and format result
  const subagentResponses: SubagentResponse[] = [];
  const resultParts: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const agent = agents[i];
    if (result.status === 'fulfilled') {
      subagentResponses.push(result.value);
      resultParts.push(`=== ${agent.name} (${agent.model}) ===\n${result.value.content}`);
    } else {
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      options.onSubagentComplete?.(agent.id, '', errorMsg);
      subagentResponses.push({
        name: agent.name,
        model: agent.model,
        content: `Error: ${errorMsg}`,
      });
      resultParts.push(`=== ${agent.name} (${agent.model}) ===\nError: ${errorMsg}`);
    }
  }

  return {
    toolResult: {
      tool_use_id: toolCall.id,
      content: resultParts.join('\n\n'),
    },
    responses: subagentResponses,
  };
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
    onApprovalRequired,
    signal,
    imageLoader,
    tools = BUILTIN_TOOLS,
    systemPrompt,
    toolContext,
  } = options;

  const toolHistory: ToolRound[] = [];
  let allToolUses: ToolUse[] = [];
  const skillUses: SkillUse[] = [];
  const allSubagentResponses: SubagentResponse[] = [];

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
        // Special handling for spawn_subagent
        if (toolCall.name === 'spawn_subagent') {
          const { toolResult, responses } = await executeSubagentTool(
            toolCall,
            `${provider.providerType}/${model}`,
            options,
          );
          allSubagentResponses.push(...responses);

          // Update the tool use entry with result summary
          const toolUseEntry = allToolUses.find(
            (t) => t.type === 'spawn_subagent' && !t.result
          );
          if (toolUseEntry) {
            toolUseEntry.result = `Spawned ${responses.length} sub-agent(s): ${responses.map(r => r.name).join(', ')}`;
          }

          return toolResult;
        }

        let toolResult = await toolRegistry.executeTool(toolCall, toolContext);

        // Handle approval flow
        if (toolResult.requires_approval && toolResult.approval_data && onApprovalRequired) {
          const approved = await onApprovalRequired(toolResult.approval_data);
          if (approved) {
            // Execute the tool again without the approval flag to actually perform the write
            const contextWithoutApproval = { ...toolContext, requireWriteApproval: false };
            toolResult = await toolRegistry.executeTool(toolCall, contextWithoutApproval);
          } else {
            // User rejected - return an error to the model
            toolResult = {
              tool_use_id: toolCall.id,
              content: `User rejected the write to ${toolResult.approval_data.path}`,
              is_error: true,
            };
          }
        }

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
    subagentResponses: allSubagentResponses,
  };
}

/**
 * Build a system prompt with skill information included.
 * Useful for triggers that need access to skills.
 */
export function buildSystemPromptWithSkills(basePrompt?: string, conversationContext?: { id: string; title?: string }): string {
  return skillRegistry.buildSystemPrompt(conversationContext) + (basePrompt ? `\n\n${basePrompt}` : '');
}
