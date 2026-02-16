import { ToolDefinition } from '../types/tools';
import { IProviderService } from './providers/types';
import { providerRegistry } from './providers/registry';
import { parseModelId } from '../types';
import { skillRegistry } from './skills/registry';

export const BACKGROUND_CONVERSATION_ID = '_background';

// Fast models for the orchestrator, in preference order
const FAST_MODEL_CANDIDATES = [
  'anthropic/claude-haiku-4-5-20251001',
  'anthropic/claude-sonnet-4-5-20250929',
];

/**
 * Resolve the fastest available model for the orchestrator.
 * Falls back to first available model if no fast model is configured.
 */
export function getOrchestratorModel(): string | null {
  const available = new Set(providerRegistry.getAllAvailableModels().map(m => m.key));

  for (const candidate of FAST_MODEL_CANDIDATES) {
    if (available.has(candidate)) return candidate;
  }

  // Fallback: first available model
  const first = providerRegistry.getAllAvailableModels()[0];
  return first?.key ?? null;
}

/**
 * The delegate tool — orchestrator's only tool.
 * Defined here, NOT in BUILTIN_TOOLS. Only used for the orchestrator API call.
 */
export const DELEGATE_TOOL: ToolDefinition = {
  name: 'delegate',
  description: 'Delegate a task to a background agent. The agent has full access to the user\'s vault (read, write, search notes/conversations/triggers), web search, and HTTP tools. The agent will complete the work asynchronously and the result will be shown to the user when done.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short task label (e.g., "Search investments", "Create trigger")' },
      prompt: { type: 'string', description: 'Detailed instructions for what the agent should do' },
    },
    required: ['name', 'prompt'],
  },
};

/**
 * Build the orchestrator system prompt.
 * The orchestrator classifies user input and delegates to background tasks.
 */
export function getOrchestratorSystemPrompt(): string {
  const now = new Date();
  return `You are the Wheelhouse orchestrator. You receive user messages and delegate work to background agents.

Current time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})

RULES:
- NEVER do work yourself. Always use the delegate tool to hand off work to an agent.
- Keep your responses to 1 short sentence acknowledging what you're doing.
- You can delegate multiple tasks for complex requests (call delegate multiple times).
- For simple acknowledgments, greetings, or clarifications, you may respond without delegating.

The delegate tool creates an async agent with full tool access: it can search conversations and notes, read and write files, search the web, and more. The agent's result will be shown to the user when complete.

Examples of how to respond:
- User: "what did I write about investments?" → delegate a search task, respond "Searching your notes and conversations..."
- User: "create a trigger to watch BTC price" → delegate, respond "Setting that up..."
- User: "I've been thinking about restructuring my portfolio..." → delegate to capture insights, respond "Capturing your thoughts..."
- User: "what's the weather in SF?" → delegate a web search, respond "Looking that up..."
- User: "hello" → respond "Hey! What can I help with?" (no delegation needed)`;
}

/**
 * Build the system prompt for a delegated task agent.
 * Includes skill descriptions and memory content.
 */
export function getTaskSystemPrompt(memoryContent?: string): string {
  // Get the skill registry's standard prompt (includes time, memory, skills)
  const skillPrompt = skillRegistry.buildSystemPrompt(
    { id: BACKGROUND_CONVERSATION_ID, title: 'Background' },
    memoryContent,
  );

  return `You are a Wheelhouse task agent. Complete your assigned task using your tools.

Be thorough but concise in your final response. You have full access to the user's vault (notes, conversations, skills, triggers) and the web.

${skillPrompt}`;
}

/**
 * Get a provider instance for a given model key.
 * Returns the provider and model ID, or null if unavailable.
 */
export function getProviderForModel(modelKey: string): { provider: IProviderService; modelId: string } | null {
  const { provider: providerType, modelId } = parseModelId(modelKey);
  const provider = providerRegistry.getProvider(providerType);
  if (!provider || !provider.isInitialized()) return null;
  return { provider, modelId };
}
