// Core types for PromptBox MVP

export type ProviderType = 'anthropic' | 'openai' | 'ollama';

export interface Message {
  // 'log' messages are for UI display only and are filtered out before sending to agents
  role: 'user' | 'assistant' | 'log';
  timestamp: string;
  content: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
}

export interface Conversation {
  id: string;
  created: string;
  provider: ProviderType;
  model: string;
  title?: string;
  memory_version?: number;
  messages: Message[];
}

export interface Config {
  vaultPath: string;
  defaultModel: string;
  // Provider API keys - presence indicates provider is enabled
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
}

export interface AppState {
  config: Config | null;
  currentConversation: Conversation | null;
  conversations: Conversation[];
  memory: string;
  isLoading: boolean;
}
