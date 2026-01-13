/**
 * Pure serialization/deserialization utilities for conversations.
 * These can be tested without Tauri dependencies.
 */
import * as yaml from 'js-yaml';
import { Conversation, Message, ComparisonMetadata, ProviderType } from '../types';

/**
 * Serialize a conversation to YAML string
 */
export function serializeConversation(conversation: Conversation): string {
  // Filter out empty messages
  const filteredMessages = conversation.messages.filter(m => m.content.trim() !== '');

  const conversationToSave = {
    ...conversation,
    messages: filteredMessages,
  };

  return yaml.dump(conversationToSave);
}

/**
 * Deserialize a YAML string to a Conversation object
 */
export function deserializeConversation(yamlContent: string): Conversation {
  return yaml.load(yamlContent) as Conversation;
}

/**
 * Validate that a comparison conversation has proper structure
 */
export function validateComparisonConversation(conversation: Conversation): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!conversation.comparison) {
    errors.push('Missing comparison metadata');
    return { valid: false, errors };
  }

  if (!conversation.comparison.isComparison) {
    errors.push('comparison.isComparison should be true');
  }

  if (!conversation.comparison.models || conversation.comparison.models.length < 2) {
    errors.push('comparison.models should have at least 2 models');
  }

  // Validate that assistant messages in comparison have provider/model fields
  const assistantMessages = conversation.messages.filter(m => m.role === 'assistant');
  const modelsWithoutIdentity = assistantMessages.filter(m => !m.provider || !m.model);

  if (modelsWithoutIdentity.length > 0 && assistantMessages.length > 0) {
    // This is a warning, not an error - old conversations may lack this
    errors.push(`${modelsWithoutIdentity.length} assistant message(s) without provider/model identity`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Group messages by user prompt for comparison display.
 * Each group has one user message followed by N assistant responses.
 */
export interface MessageGroup {
  userMessage: string;
  userTimestamp: string;
  responses: Array<{
    content: string;
    timestamp: string;
    provider?: ProviderType;
    model?: string;
  }>;
}

export function groupMessagesByPrompt(
  messages: Message[],
  modelCount: number
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const responses: MessageGroup['responses'] = [];

      // Collect following assistant messages
      for (let j = 0; j < modelCount && i + 1 + j < messages.length; j++) {
        const nextMsg = messages[i + 1 + j];
        if (nextMsg.role === 'assistant') {
          responses.push({
            content: nextMsg.content,
            timestamp: nextMsg.timestamp,
            provider: nextMsg.provider,
            model: nextMsg.model,
          });
        }
      }

      groups.push({
        userMessage: msg.content,
        userTimestamp: msg.timestamp,
        responses,
      });
      i += 1 + responses.length;
    } else {
      i++;
    }
  }

  return groups;
}

/**
 * Get display name for a model response.
 * Prioritizes the provider/model stored on the message itself,
 * falls back to positional matching with comparison metadata.
 */
export function getModelDisplayName(
  response: { provider?: ProviderType; model?: string },
  index: number,
  comparisonModels?: Array<{ provider: ProviderType; model: string }>
): string {
  // First try: use provider/model from the message itself
  if (response.provider && response.model) {
    return `${response.provider}/${response.model}`;
  }

  // Fallback: use positional matching with comparison metadata
  if (comparisonModels && comparisonModels[index]) {
    const meta = comparisonModels[index];
    return `${meta.provider}/${meta.model}`;
  }

  return `Model ${index + 1}`;
}

/**
 * Create a new comparison conversation
 */
export function createComparisonConversation(
  models: Array<{ provider: ProviderType; model: string }>
): Conversation {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  const hash = Math.random().toString(16).slice(2, 6);

  const comparisonMetadata: ComparisonMetadata = {
    isComparison: true,
    models,
  };

  return {
    id: `${date}-${time}-${hash}-compare`,
    created: now.toISOString(),
    provider: models[0].provider,
    model: models[0].model,
    messages: [],
    comparison: comparisonMetadata,
  };
}

/**
 * Create assistant messages from comparison responses
 */
export function createComparisonAssistantMessages(
  responses: Array<{ provider: ProviderType; model: string; content: string }>
): Message[] {
  const timestamp = new Date().toISOString();
  return responses.map(response => ({
    role: 'assistant' as const,
    timestamp,
    content: response.content,
    provider: response.provider,
    model: response.model,
  }));
}
