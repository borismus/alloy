import { Message } from '../../types';
import { IProviderService } from '../providers/types';
import { estimateMessageTokens } from './estimator';
import { COMPACTION_PROMPT, formatCompactSummary, createCompactionMessage } from './compactionPrompt';

// Trigger compaction when messages exceed this fraction of the budget
const COMPACTION_THRESHOLD = 0.7;
// Keep at least this many recent messages after compaction
const KEEP_RECENT_MESSAGES = 6;

export interface CompactionResult {
  /** The compacted summary text */
  summary: string;
  /** Messages to use going forward: [summary message, ...kept recent messages] */
  messages: Message[];
  /** How many messages were compacted */
  compactedCount: number;
}

/**
 * Check if compaction should be triggered based on current message token usage.
 */
export function shouldCompact(
  messages: Message[],
  messageBudget: number,
): boolean {
  const nonLogMessages = messages.filter(m => m.role !== 'log');
  if (nonLogMessages.length <= KEEP_RECENT_MESSAGES + 2) {
    return false; // Not enough messages to warrant compaction
  }

  const totalTokens = nonLogMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );

  return totalTokens > messageBudget * COMPACTION_THRESHOLD;
}

/**
 * Compact older messages into a summary using the current model.
 * Keeps the most recent messages intact and replaces older ones
 * with a single summary message.
 */
export async function compactConversation(
  messages: Message[],
  model: string,
  provider: IProviderService,
): Promise<CompactionResult> {
  const nonLogMessages = messages.filter(m => m.role !== 'log');
  const logMessages = messages.filter(m => m.role === 'log');

  // Split: older messages to summarize, recent messages to keep
  const splitIndex = Math.max(0, nonLogMessages.length - KEEP_RECENT_MESSAGES);
  const toSummarize = nonLogMessages.slice(0, splitIndex);
  const toKeep = nonLogMessages.slice(splitIndex);

  if (toSummarize.length === 0) {
    return {
      summary: '',
      messages,
      compactedCount: 0,
    };
  }

  // Send older messages to the model for summarization
  const summaryMessages: Message[] = [
    ...toSummarize,
    {
      role: 'user' as const,
      timestamp: new Date().toISOString(),
      content: COMPACTION_PROMPT,
    },
  ];

  try {
    const result = await provider.sendMessage(summaryMessages, {
      model,
      tools: [], // No tools during compaction
    });

    const summary = formatCompactSummary(result.content);
    const summaryMessage: Message = {
      role: 'user' as const,
      timestamp: toSummarize[0].timestamp, // Preserve original start time
      content: createCompactionMessage(summary),
    };

    return {
      summary,
      messages: [summaryMessage, ...toKeep, ...logMessages],
      compactedCount: toSummarize.length,
    };
  } catch (error) {
    console.error('Context compaction failed, falling back to truncation:', error);
    // On failure, return original messages — mechanical truncation will handle it
    return {
      summary: '',
      messages,
      compactedCount: 0,
    };
  }
}
