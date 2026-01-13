import { Message, ModelInfo, ProviderType } from '../../types';

export interface ChatOptions {
  model: string;
  systemPrompt?: string;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export interface IProviderService {
  readonly providerType: ProviderType;

  initialize(apiKeyOrBaseUrl: string): void;
  isInitialized(): boolean;

  sendMessage(messages: Message[], options: ChatOptions): Promise<string>;

  generateTitle(userMessage: string, assistantResponse: string): Promise<string>;

  getAvailableModels(): ModelInfo[];
}
