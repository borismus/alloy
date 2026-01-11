// Core types for PromptBox MVP

export interface Message {
  role: 'user' | 'assistant';
  timestamp: string;
  content: string;
}

export interface Conversation {
  id: string;
  created: string;
  model: string;
  title?: string;
  memory_version?: number;
  messages: Message[];
}

export interface Config {
  vaultPath: string;
  anthropicApiKey: string;
  defaultModel: string;
}

export interface AppState {
  config: Config | null;
  currentConversation: Conversation | null;
  conversations: Conversation[];
  memory: string;
  isLoading: boolean;
}
