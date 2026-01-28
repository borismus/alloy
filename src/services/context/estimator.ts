import { Message } from '../../types';
import { ToolDefinition } from '../../types/tools';

/**
 * Estimate token count from text using ~4 chars per token heuristic.
 * This is approximate but fast and works well for most English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a Message object including content and overhead.
 */
export function estimateMessageTokens(message: Message): number {
  let tokens = estimateTokens(message.content);

  // Add overhead for role, timestamp, message structure
  tokens += 10;

  // Attachments add tokens (rough estimate for image descriptions)
  if (message.attachments?.length) {
    tokens += message.attachments.length * 1000; // Images are ~1K tokens each
  }

  // Tool use results within messages
  if (message.toolUse?.length) {
    for (const tool of message.toolUse) {
      tokens += estimateTokens(tool.result || '');
      tokens += 20; // Tool metadata overhead
    }
  }

  return tokens;
}

/**
 * Estimate tokens for an array of tool definitions.
 */
export function estimateToolTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) => {
    return sum + estimateTokens(
      tool.name + tool.description + JSON.stringify(tool.input_schema)
    );
  }, 0);
}

/**
 * Truncate text to fit within a token budget, preserving the end (most recent info).
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens <= maxTokens) {
    return text;
  }

  // Keep the end of the text (most recent/relevant info)
  const maxChars = maxTokens * 4;
  const truncated = text.slice(-maxChars);

  // Find a clean break point (paragraph or sentence)
  const cleanBreak = truncated.search(/(?:^|\n\n|\. )/);
  if (cleanBreak > 0 && cleanBreak < 200) {
    return '[...truncated...]\n\n' + truncated.slice(cleanBreak).replace(/^[\n. ]+/, '');
  }

  return '[...truncated...]\n\n' + truncated;
}
