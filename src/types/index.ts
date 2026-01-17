// Core types for PromptBox MVP

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'gemini';

export interface Attachment {
  type: 'image';
  path: string;          // Relative path: attachments/{convId}-img-001.png
  mimeType: string;      // image/png, image/jpeg, image/gif, image/webp
}

export interface ToolUse {
  type: string;           // tool name: 'read_file', 'http_post', etc.
  input?: Record<string, unknown>;  // tool inputs (for debugging)
  result?: string;        // truncated result (for display)
  isError?: boolean;
}

export interface Message {
  // 'log' messages are for UI display only and are filtered out before sending to agents
  role: 'user' | 'assistant' | 'log';
  timestamp: string;
  content: string;
  // For comparison mode - which model generated this assistant response
  provider?: ProviderType;
  model?: string;
  // Attachments (images, etc.)
  attachments?: Attachment[];
  // Tools used in this message (e.g., web search)
  toolUse?: ToolUse[];
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

// Topic metadata - makes a conversation a "standing query"
export interface TopicMetadata {
  label: string;    // Short name for pill display (e.g., "Iran", "SF Trip")
  prompt: string;   // The standing query to re-ask when clicking the topic
  lastSent?: string; // ISO timestamp of last auto-send (for cooldown)
}

// Pending topic prompt with target conversation ID
export interface PendingTopicPrompt {
  prompt: string;
  targetId: string;
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
  topic?: TopicMetadata;  // If set, conversation appears as a topic pill instead of in sidebar list
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

// Per-conversation streaming state
export interface ConversationStreamingState {
  isStreaming: boolean;
  streamingContent: string;
  streamingToolUse?: ToolUse[];
  error?: string;
}
