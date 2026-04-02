import { Message } from '../../types';
import { ToolDefinition } from '../../types/tools';
import { estimateTokens, estimateMessageTokens, estimateToolTokens, truncateToTokenBudget } from './estimator';

// Default budget when no model context window is known
const DEFAULT_TOTAL_BUDGET = 16000;
const DEFAULT_RESPONSE_RESERVE = 4000;
const DEFAULT_TOOL_RESULT_MAX_TOKENS = 500;

// Microcompaction: tool results older than this many assistant turns get cleared
const MICROCOMPACT_KEEP_TURNS = 3;
// Tools whose results are safe to clear after a few turns
const COMPACTABLE_TOOLS = new Set([
  'read_file', 'search_files', 'list_files', 'web_search', 'web_fetch',
]);

export interface ContextBudget {
  total: number;        // Total token budget
  systemPrompt: number; // Tokens used by system prompt
  tools: number;        // Tokens used by tool definitions
  response: number;     // Reserved for model response
  messages: number;     // Available for conversation messages
}

export interface TruncatedContext {
  messages: Message[];
  estimatedTokens: number;
  truncated: boolean;
  truncatedCount: number; // How many old messages were dropped
  contentTruncated: boolean; // Whether the latest message content was truncated
}

export interface ContextManagerConfig {
  totalBudget?: number;
  responseReserve?: number;
  toolResultMaxTokens?: number;
  contextWindow?: number; // Model's actual context window size
}

export class ContextManager {
  private config: Required<Omit<ContextManagerConfig, 'contextWindow'>> & { contextWindow?: number };

  constructor(config?: ContextManagerConfig) {
    this.config = {
      totalBudget: config?.totalBudget ?? DEFAULT_TOTAL_BUDGET,
      responseReserve: config?.responseReserve ?? DEFAULT_RESPONSE_RESERVE,
      toolResultMaxTokens: config?.toolResultMaxTokens ?? DEFAULT_TOOL_RESULT_MAX_TOKENS,
      contextWindow: config?.contextWindow,
    };
  }

  /**
   * Calculate token budget based on system prompt and tools.
   * Uses model context window if available, otherwise falls back to default budget.
   */
  calculateBudget(systemPrompt: string, tools: ToolDefinition[]): ContextBudget {
    const systemPromptTokens = estimateTokens(systemPrompt);
    const toolTokens = estimateToolTokens(tools);
    const totalBudget = this.config.contextWindow || this.config.totalBudget;

    const availableForMessages = Math.max(
      0,
      totalBudget - systemPromptTokens - toolTokens - this.config.responseReserve
    );

    return {
      total: totalBudget,
      systemPrompt: systemPromptTokens,
      tools: toolTokens,
      response: this.config.responseReserve,
      messages: availableForMessages,
    };
  }

  /**
   * Clear stale tool results from older messages to reclaim context space.
   * Keeps tool results from the most recent N assistant turns intact.
   * Only clears results from read-heavy tools (file reads, searches).
   */
  microcompact(messages: Message[]): Message[] {
    // Count assistant turns from the end to find the cutoff
    let assistantTurnCount = 0;
    // (cutoff determined below)
    const turnCutoffIndices: number[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        assistantTurnCount++;
        if (assistantTurnCount === MICROCOMPACT_KEEP_TURNS) {
          turnCutoffIndices.push(i);
          break;
        }
      }
    }

    // If we don't have enough turns, nothing to compact
    if (turnCutoffIndices.length === 0) {
      return messages;
    }

    const cutoff = turnCutoffIndices[0];

    return messages.map((message, index) => {
      // Only compact messages before the cutoff
      if (index >= cutoff || !message.toolUse?.length) {
        return message;
      }

      const compacted = message.toolUse.map(tool => {
        // Only clear results from compactable tools
        if (!tool.result || !COMPACTABLE_TOOLS.has(tool.type)) {
          return tool;
        }
        // Skip if already cleared
        if (tool.result === '[Tool result cleared]') {
          return tool;
        }
        return {
          ...tool,
          result: `[Tool result cleared — ${tool.type}]`,
        };
      });

      const hasChanges = compacted.some((t, i) => t !== message.toolUse![i]);
      return hasChanges ? { ...message, toolUse: compacted } : message;
    });
  }

  /**
   * Prepare messages to fit within budget.
   * The most recent message is always included (truncated if necessary).
   * Remaining budget is filled with older messages, newest first.
   * Returns messages in chronological order (oldest first).
   */
  prepareContext(messages: Message[], budget: ContextBudget): TruncatedContext {
    // Filter out log messages (UI-only)
    const filtered = messages.filter(m => m.role !== 'log');

    if (filtered.length === 0) {
      return {
        messages: [],
        estimatedTokens: 0,
        truncated: false,
        truncatedCount: 0,
        contentTruncated: false,
      };
    }

    // Step 1: Microcompact stale tool results
    const microcompacted = this.microcompact(filtered);

    // Step 2: Truncate tool results within messages to save tokens
    const withTruncatedTools = microcompacted.map(m => this.truncateToolResults(m));

    const result: Message[] = [];
    let totalTokens = 0;
    let contentTruncated = false;

    // Always include the most recent message, truncating its content if needed
    const newest = withTruncatedTools[withTruncatedTools.length - 1];
    const newestTokens = estimateMessageTokens(newest);

    if (newestTokens > budget.messages) {
      // Truncate content to fit the budget (leave room for message overhead)
      const overhead = newestTokens - estimateTokens(newest.content);
      const contentBudget = Math.max(100, budget.messages - overhead);
      const truncatedContent = truncateToTokenBudget(newest.content, contentBudget);
      const truncatedNewest = { ...newest, content: truncatedContent };
      result.push(truncatedNewest);
      totalTokens = estimateMessageTokens(truncatedNewest);
      contentTruncated = true;
    } else {
      result.push(newest);
      totalTokens = newestTokens;
    }

    // Fill remaining budget with older messages, newest first
    for (let i = withTruncatedTools.length - 2; i >= 0; i--) {
      const message = withTruncatedTools[i];
      const messageTokens = estimateMessageTokens(message);

      if (totalTokens + messageTokens > budget.messages) {
        break;
      }

      result.unshift(message);
      totalTokens += messageTokens;
    }

    // Count dropped messages (not including the newest which is always kept)
    const truncatedCount = withTruncatedTools.length - result.length;

    return {
      messages: result,
      estimatedTokens: totalTokens,
      truncated: truncatedCount > 0 || contentTruncated,
      truncatedCount,
      contentTruncated,
    };
  }

  /**
   * Truncate verbose tool results within a message.
   */
  private truncateToolResults(message: Message): Message {
    if (!message.toolUse?.length) {
      return message;
    }

    const maxChars = this.config.toolResultMaxTokens * 4;

    const truncatedToolUse = message.toolUse.map(tool => {
      if (!tool.result || tool.result.length <= maxChars) {
        return tool;
      }

      // Keep start and end, truncate middle
      const halfLen = Math.floor(maxChars / 2) - 20;
      const truncatedResult =
        tool.result.slice(0, halfLen) +
        '\n\n[...truncated...]\n\n' +
        tool.result.slice(-halfLen);

      return { ...tool, result: truncatedResult };
    });

    return { ...message, toolUse: truncatedToolUse };
  }
}

export const contextManager = new ContextManager();
