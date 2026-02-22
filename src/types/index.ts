// Core types for Wheelhouse

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'gemini' | 'grok';

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

// Token usage and cost tracking for an API response
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cost?: number;        // Estimated USD (omitted for free/unknown models)
  responseId?: string;  // Provider response ID for billing cross-reference
}

// Sub-agent response stored on completed messages
export interface SubagentResponse {
  name: string;           // Short label (e.g., "Research", "Analysis")
  model: string;          // Format: "provider/model-id"
  prompt?: string;        // The prompt given to the sub-agent
  content: string;
  toolUse?: ToolUse[];
  skillUse?: SkillUse[];
  usage?: Usage;
}

// Sub-agent streaming state during execution
export interface SubagentStreamingState {
  name: string;
  model: string;
  prompt?: string;
  content: string;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  error?: string;
  toolUse?: ToolUse[];
}

export interface Message {
  // Unique identifier for provenance tracking (e.g., 'msg-a1b2')
  id?: string;
  // 'log' messages are for UI display only and are filtered out before sending to agents
  role: 'user' | 'assistant' | 'log';
  timestamp: string;
  content: string;
  // Which model generated this assistant response
  // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  model?: string;
  // Attachments (images, etc.)
  attachments?: Attachment[];
  // Tools used in this message (e.g., web search)
  toolUse?: ToolUse[];
  // Skills applied in this message
  skillUse?: SkillUse[];
  // Sub-agent responses spawned during this message
  subagentResponses?: SubagentResponse[];
  // Source of the message for background mode rendering
  source?: 'orchestrator' | 'task';
  // Token usage and cost for this response
  usage?: Usage;
}

export interface ModelInfo {
  key: string;   // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  name: string;  // Human-readable display name (e.g., "Sonnet 4.5")
}

// Single trigger attempt record
export interface TriggerAttempt {
  timestamp: string;
  result: 'triggered' | 'skipped' | 'error';
  reasoning: string;  // Explanation for triggered/skipped, empty for error
  error?: string;     // Error message when result is 'error'
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

// Standalone trigger stored in triggers/ directory (flat structure)
export interface Trigger {
  id: string;
  created: string;
  updated: string;
  title: string;
  model: string;  // Format: "provider/model-id"
  // Trigger configuration (previously nested under trigger:)
  enabled: boolean;
  triggerPrompt: string;           // The prompt to evaluate and respond to
  intervalMinutes: number;         // e.g., 60 for hourly
  lastChecked?: string;            // ISO timestamp
  lastTriggered?: string;          // ISO timestamp
  history?: TriggerAttempt[];      // Recent trigger attempts (most recent first)
  // Messages
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
  XAI_API_KEY?: string;
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
  // Active sub-agents during streaming (keyed by agent ID)
  activeSubagents?: Map<string, SubagentStreamingState>;
  // Parent text from before sub-agents were spawned (streamingContent is reset for synthesis)
  preSubagentContent?: string;
}

// Timeline filter type (replaces old SidebarTab)
export type TimelineFilter = 'all' | 'conversations' | 'notes' | 'triggers' | 'rambles';

// Note metadata for sidebar display
export interface NoteInfo {
  filename: string;        // e.g., "my-note.md"
  lastModified: number;    // Unix timestamp for sorting
  hasSkillContent: boolean; // true if contains &[[...]] markers
  isRamble?: boolean;      // true if in rambles/ directory
  isIntegrated?: boolean;  // for rambles: whether integrated into notes
  title?: string;          // for rambles: custom title from frontmatter
}

// Unified timeline item for sidebar display
export interface TimelineItem {
  type: 'conversation' | 'note' | 'trigger' | 'ramble';
  id: string;              // conversation id, note filename, or trigger id
  title: string;           // display title
  lastUpdated: number;     // unix timestamp for sorting
  preview?: string;        // optional preview text
  // Type-specific data (one will be set based on type)
  conversation?: Conversation;
  note?: NoteInfo;
  trigger?: Trigger;
}

// Selection state for main panel routing
export type SelectedItem =
  | { type: 'conversation'; id: string }
  | { type: 'note'; id: string }      // id = filename
  | { type: 'trigger'; id: string }
  | null;

// Ramble mode: proposed changes to integrate into other notes
export interface ProposedChange {
  type: 'create' | 'update' | 'append';
  path: string;              // e.g., "notes/topic.md"
  description: string;       // Human-readable description of change
  newContent: string;        // Content to write/append
  reasoning: string;         // Why this change is proposed
}
