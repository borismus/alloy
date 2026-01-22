/**
 * Pure serialization/deserialization utilities for conversations.
 * These can be tested without Tauri dependencies.
 */
import * as yaml from 'js-yaml';
import { Conversation, Message, ComparisonMetadata } from '../types';

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

  // Validate that assistant messages in comparison have model field
  const assistantMessages = conversation.messages.filter(m => m.role === 'assistant');
  const modelsWithoutIdentity = assistantMessages.filter(m => !m.model);

  if (modelsWithoutIdentity.length > 0 && assistantMessages.length > 0) {
    // This is a warning, not an error - old conversations may lack this
    errors.push(`${modelsWithoutIdentity.length} assistant message(s) without model identity`);
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
    model?: string;  // Format: "provider/model-id"
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
 * Uses the model string directly since it's already in "provider/model-id" format.
 */
export function getModelDisplayName(
  response: { model?: string },
  index: number,
  comparisonModels?: string[]
): string {
  // First try: use model from the message itself
  if (response.model) {
    return response.model;
  }

  // Fallback: use positional matching with comparison metadata
  if (comparisonModels && comparisonModels[index]) {
    return comparisonModels[index];
  }

  return `Model ${index + 1}`;
}

/**
 * Create a new comparison conversation
 */
export function createComparisonConversation(
  models: string[]  // Format: "provider/model-id"
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
    updated: now.toISOString(),
    model: models[0],
    messages: [],
    comparison: comparisonMetadata,
  };
}

/**
 * Create assistant messages from comparison responses
 */
export function createComparisonAssistantMessages(
  responses: Array<{ model: string; content: string }>  // model format: "provider/model-id"
): Message[] {
  const timestamp = new Date().toISOString();
  return responses.map(response => ({
    role: 'assistant' as const,
    timestamp,
    content: response.content,
    model: response.model,
  }));
}
