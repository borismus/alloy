// Core types for Orchestra

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'gemini';

// Helper functions for unified model format: "provider/model-id"
export function parseModelId(modelString: string): { provider: ProviderType; modelId: string } {
  const [provider, ...rest] = modelString.split('/');
  return {
    provider: provider as ProviderType,
    modelId: rest.join('/'),  // Handle model IDs that might contain '/'
  };
}

export function formatModelId(provider: ProviderType, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function getProviderFromModel(modelString: string): ProviderType {
  return parseModelId(modelString).provider;
}

export function getModelIdFromModel(modelString: string): string {
  return parseModelId(modelString).modelId;
}

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

export interface SkillUse {
  name: string;           // skill name: 'critique-writing', 'web-search', etc.
  description?: string;   // skill description for display
}

export interface Message {
  // 'log' messages are for UI display only and are filtered out before sending to agents
  role: 'user' | 'assistant' | 'log';
  timestamp: string;
  content: string;
  // For comparison/council mode - which model generated this assistant response
  // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  model?: string;
  // Attachments (images, etc.)
  attachments?: Attachment[];
  // Tools used in this message (e.g., web search)
  toolUse?: ToolUse[];
  // Skills applied in this message
  skillUse?: SkillUse[];
  // Council mode - marks message role in council deliberation
  councilMember?: boolean;  // True if this is a council member response
  chairman?: boolean;       // True if this is the chairman synthesis
}

export interface ModelInfo {
  key: string;   // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  name: string;  // Human-readable display name (e.g., "Sonnet 4.5")
}

// Track each model's response in a comparison
export interface ComparisonResponse {
  model: string;  // Format: "provider/model-id"
  content: string;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  error?: string;
  toolUse?: ToolUse[];
  skillUse?: SkillUse[];
}

// Metadata for comparison conversations
export interface ComparisonMetadata {
  isComparison: true;
  models: string[];  // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
}

// Metadata for council conversations
export interface CouncilMetadata {
  isCouncil: true;
  councilMembers: string[];  // Format: "provider/model-id"
  chairman: string;  // Format: "provider/model-id"
}

// Single trigger attempt record
export interface TriggerAttempt {
  timestamp: string;
  result: 'triggered' | 'skipped' | 'error';
  reasoning: string;  // Explanation for triggered/skipped, empty for error
  error?: string;     // Error message when result is 'error'
}

// Trigger configuration for automated background execution
export interface TriggerConfig {
  enabled: boolean;
  triggerPrompt: string;           // The prompt to evaluate and respond to
  model: string;                   // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  intervalMinutes: number;         // e.g., 60 for hourly
  lastChecked?: string;            // ISO timestamp
  lastTriggered?: string;          // ISO timestamp
  history?: TriggerAttempt[];      // Recent trigger attempts (most recent first)
}

// Result of a trigger check
export interface TriggerResult {
  result: 'triggered' | 'skipped' | 'error';
  response: string;   // Full response if triggered, brief reasoning if skipped
  error?: string;     // Error message when result is 'error'
}

// Log entry for trigger execution history
export interface TriggerLogEntry {
  timestamp: string;
  conversationId: string;
  conversationTitle?: string;
  triggered: boolean;
  reasoning: string;
  error?: string;
}

// Standalone trigger stored in triggers/ directory
export interface Trigger {
  id: string;
  created: string;
  updated: string;
  title: string;
  model: string;  // Format: "provider/model-id"
  trigger: TriggerConfig;  // Required for triggers
  messages: Message[];
}

export interface Conversation {
  id: string;
  created: string;
  updated: string;
  model: string;  // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  title?: string;
  memory_version?: number;
  messages: Message[];
  comparison?: ComparisonMetadata;
  council?: CouncilMetadata;
  trigger?: TriggerConfig;  // If set, conversation runs as a triggered background task
}

export interface Config {
  defaultModel: string;  // Format: "provider/model-id" (e.g., "anthropic/claude-opus-4-5-20251101")
  // Favorite models shown at top of selectors (e.g., "anthropic/claude-opus-4-5-20251101")
  favoriteModels?: string[];
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

// Sidebar tab type
export type SidebarTab = 'chats' | 'notes';

// Note metadata for sidebar display
export interface NoteInfo {
  filename: string;        // e.g., "my-note.md"
  lastModified: number;    // Unix timestamp for sorting
  hasSkillContent: boolean; // true if contains &[[...]] markers
}
