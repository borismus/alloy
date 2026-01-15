// Core types for PromptBox MVP

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'gemini';

export interface Message {
  // 'log' messages are for UI display only and are filtered out before sending to agents
  role: 'user' | 'assistant' | 'log';
  timestamp: string;
  content: string;
  // For comparison mode - which model generated this assistant response
  provider?: ProviderType;
  model?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
}

// Track each model's response in a comparison
export interface ComparisonResponse {
  provider: ProviderType;
  model: string;
  content: string;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  error?: string;
}

// Metadata for comparison conversations
export interface ComparisonMetadata {
  isComparison: true;
  models: Array<{ provider: ProviderType; model: string }>;
}

export interface Conversation {
  id: string;
  created: string;
  updated: string;
  provider: ProviderType;
  model: string;
  title?: string;
  memory_version?: number;
  messages: Message[];
  comparison?: ComparisonMetadata;
}

export interface Config {
  vaultPath: string;
  defaultModel: string;
  // Provider API keys - presence indicates provider is enabled
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  GEMINI_API_KEY?: string;
}

export interface AppState {
  config: Config | null;
  currentConversation: Conversation | null;
  conversations: Conversation[];
  memory: string;
  isLoading: boolean;
}
