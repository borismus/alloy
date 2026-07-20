// Core types for Alloy

export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'gemini' | 'grok' | 'openrouter' | 'claude-cli' | 'mlx';

/** Minimal conversation reference for wiki-link title lookups */
export interface ConversationInfo {
  id: string;
  title?: string;
}

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
  type: string;           // tool name: 'read_file', 'http_get', etc.
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
  inputTokens: number;              // Uncached input tokens (billed at full rate)
  outputTokens: number;
  cachedInputTokens?: number;       // Tokens read from prompt cache (billed at ~10% rate, Anthropic)
  cacheCreationInputTokens?: number; // Tokens written to prompt cache (billed at ~125% rate, Anthropic)
  cost?: number;        // Estimated USD (omitted for free/unknown models)
  responseId?: string;  // Provider response ID for billing cross-reference
  durationMs?: number;  // Wall-clock time to produce the response (model + tool loop)
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

export interface QueuedMessage {
  id: string;
  content: string;
  pendingImages: Array<{ data: Uint8Array; mimeType: string; preview: string }>;
}

export interface Message {
  // Unique identifier for provenance tracking (e.g., 'msg-a1b2')
  id?: string;
  // 'log' messages are for UI display only and are filtered out before sending to agents.
  // 'compacted' messages are server-generated summaries of older turns: they are kept in
  // history and rendered as a card, but at send time the server transmits only the most
  // recent compacted message (as context) plus everything after it. See alloy-server/src/compaction.rs.
  role: 'user' | 'assistant' | 'log' | 'compacted';
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
  // Token usage and cost for this response
  usage?: Usage;
}

export interface ModelInfo {
  key: string;   // Format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")
  name: string;  // Human-readable display name (e.g., "Sonnet 4.5")
  contextWindow?: number; // Max input tokens (e.g., 200000 for Claude, 1000000 for Gemini)
  provider?: string;      // Provider id (e.g., "mlx", "ollama") for unambiguous labeling
  local?: boolean;        // True when served from this machine (loopback) — prompts stay on-device
}

export interface TaskSchedule {
  cron: string;
  timezone: string;
}

export interface TaskTrigger {
  condition: string;
}

export interface TaskAttempt {
  timestamp: string;
  result: 'completed' | 'triggered' | 'skipped' | 'error';
  reasoning: string;
  error?: string;
  usage?: Usage;
}

// Scheduled task stored in tasks/. `trigger` is the optional delivery gate:
// without it every successful run is delivered; with it the result is surfaced
// only when the condition is met.
export interface ScheduledTask {
  id: string;
  created: string;
  updated: string;
  title: string;
  model: string;
  enabled: boolean;
  /** When true, delivered results are also emailed via services.email (Resend). */
  email?: boolean;
  prompt: string;
  schedule: TaskSchedule;
  trigger?: TaskTrigger;
  lastScheduledAt?: string;
  lastRunAt?: string;
  lastDeliveredAt?: string;
  history?: TaskAttempt[];
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
  // ISO timestamp of the most recent compaction (auto or manual). Omitted if never compacted.
  lastCompactedAt?: string;
  // False for list summaries loaded metadata-only (messages: []) at startup;
  // true/undefined once the full conversation has been loaded. Drives lazy
  // loading of message bodies on open. See vaultService.loadConversationSummaries.
  messagesLoaded?: boolean;
}

export interface Config {
  defaultModel: string;  // Format: "provider/model-id" (e.g., "anthropic/claude-opus-4-6")
  // Favorite models shown at top of selectors (e.g., "anthropic/claude-opus-4-6")
  favoriteModels?: string[];
  // User-defined models, additive to the bundled defaults.
  // Entries whose key collides with a bundled model are ignored.
  models?: ModelInfo[];
  // Where the "Edit" actions open vault files. 'obsidian' opens markdown notes
  // via the obsidian:// URI; 'system' (and any non-markdown file) opens with the
  // OS default app. Defaults to 'obsidian' when unset.
  externalEditor?: 'obsidian' | 'system';
  // Provider API keys - presence indicates provider is enabled
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  SONIOX_API_KEY?: string;
}

// Per-conversation streaming state
export interface ConversationStreamingState {
  isStreaming: boolean;
  streamingContent: string;
  /** Provider-supplied reasoning for the active stream only; never persisted. */
  streamingThinking?: string;
  thinkingStartedAt?: number;
  thinkingElapsedMs?: number;
  thinkingDurationMs?: number;
  streamingToolUse?: ToolUse[];
  error?: string;
  // Active sub-agents during streaming (keyed by agent ID)
  activeSubagents?: Map<string, SubagentStreamingState>;
  // Parent text from before sub-agents were spawned (streamingContent is reset for synthesis)
  preSubagentContent?: string;
}

// Timeline filter type (replaces old SidebarTab)
export type TimelineFilter = 'all' | 'conversations' | 'notes' | 'tasks' | 'riffs';

export type RiffArtifactType = 'note' | 'mermaid' | 'table' | 'summary';

export interface RiffMessage {
  role: 'user';
  timestamp: string;
  content: string;
}

export type RiffInterventionType = 'big-question' | 'memory-recall' | 'question-answer' | 'oblique-strategy';

export interface RiffInterventionAnchor {
  paragraphIndex: number;
  snippet: string;
}

export interface RiffIntervention {
  id: string;
  type: RiffInterventionType;
  timestamp: string;
  anchor: RiffInterventionAnchor;
  content: string;
  metadata?: {
    noteReference?: string;   // For memory-recall type
    obliqueCard?: string;      // For oblique-strategy type
  };
}

// Note metadata for sidebar display
export interface NoteInfo {
  filename: string;        // e.g., "my-note.md"
  lastModified: number;    // Unix timestamp for sorting
  hasSkillContent: boolean; // true if contains &[[...]] markers
  isRiff?: boolean;      // true if in riffs/ directory
  isIntegrated?: boolean;  // for riffs: whether integrated into notes
  title?: string;          // for riffs: custom title from frontmatter
  artifactType?: RiffArtifactType;  // for riffs: what kind of artifact
  content?: string;        // note body text, loaded for full-text search
}

// Unified timeline item for sidebar display
export interface TimelineItem {
  type: 'conversation' | 'note' | 'task' | 'riff';
  id: string;              // conversation id, note filename, or task id
  title: string;           // display title
  lastUpdated: number;     // unix timestamp for sorting
  preview?: string;        // optional preview text
  // Type-specific data (one will be set based on type)
  conversation?: Conversation;
  note?: NoteInfo;
  task?: ScheduledTask;
}

// Selection state for main panel routing
export type SelectedItem =
  | { type: 'conversation'; id: string }
  | { type: 'note'; id: string }      // id = filename
  | { type: 'task'; id: string }
  | null;

// Riff mode: proposed changes to integrate into other notes
export interface ProposedChange {
  type: 'create' | 'update' | 'append';
  path: string;              // e.g., "notes/topic.md"
  description: string;       // Human-readable description of change
  newContent: string;        // Content to write/append
  reasoning: string;         // Why this change is proposed
}
