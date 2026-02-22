import { Message, ModelInfo, ProviderType, ToolUse } from '../../types';
import { ToolDefinition, ToolCall } from '../../types/tools';

// Represents one round of tool use: assistant's tool calls + the results
export interface ToolRound {
  textContent?: string;  // Any text the assistant said alongside tool calls
  toolCalls: ToolCall[];
  toolResults: { tool_use_id: string; content: string; is_error?: boolean }[];
}

export interface ChatOptions {
  model: string;
  systemPrompt?: string;
  tools?: ToolDefinition[];  // Available tools for this request
  onChunk?: (text: string) => void;
  onToolUse?: (toolUse: ToolUse) => void;  // Called when tool use is detected
  signal?: AbortSignal;
  imageLoader?: (relativePath: string) => Promise<string>;  // Load image as base64
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

export interface ChatResult {
  content: string;
  toolUse?: ToolUse[];  // Tools used during this response (for UI display)
  toolCalls?: ToolCall[];  // Tool calls that need execution (when stopReason is 'tool_use')
  stopReason?: StopReason;
  usage?: { inputTokens: number; outputTokens: number; responseId?: string };
}

export interface IProviderService {
  readonly providerType: ProviderType;

  initialize(apiKeyOrBaseUrl: string): void;
  isInitialized(): boolean;

  sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult>;

  generateTitle(userMessage: string, assistantResponse: string): Promise<string>;

  getAvailableModels(): ModelInfo[];
}
