import { Message, ModelInfo, ProviderType, ToolUse } from '../../types';

export interface ChatOptions {
  model: string;
  systemPrompt?: string;
  onChunk?: (text: string) => void;
  onToolUse?: (toolUse: ToolUse) => void;  // Called when tool use is detected
  signal?: AbortSignal;
  imageLoader?: (relativePath: string) => Promise<string>;  // Load image as base64
}

export interface ChatResult {
  content: string;
  toolUse?: ToolUse[];  // Tools used during this response
}

export interface IProviderService {
  readonly providerType: ProviderType;

  initialize(apiKeyOrBaseUrl: string): void;
  isInitialized(): boolean;

  sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult>;

  generateTitle(userMessage: string, assistantResponse: string): Promise<string>;

  getAvailableModels(): ModelInfo[];
}
