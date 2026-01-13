import { describe, it, expect } from 'vitest';
import {
  serializeConversation,
  deserializeConversation,
  validateComparisonConversation,
  groupMessagesByPrompt,
  getModelDisplayName,
  createComparisonConversation,
  createComparisonAssistantMessages,
} from './conversationSerializer';
import type { Conversation, Message } from '../types';

describe('conversationSerializer', () => {
  describe('serializeConversation / deserializeConversation', () => {
    it('should round-trip a standard conversation', () => {
      const conversation: Conversation = {
        id: '2024-01-15-1430-abcd-test',
        created: '2024-01-15T14:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101',
        title: 'Test Conversation',
        messages: [
          { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Hello' },
          { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'Hi there!' },
        ],
      };

      const yaml = serializeConversation(conversation);
      const deserialized = deserializeConversation(yaml);

      expect(deserialized.id).toBe(conversation.id);
      expect(deserialized.provider).toBe(conversation.provider);
      expect(deserialized.model).toBe(conversation.model);
      expect(deserialized.messages).toHaveLength(2);
      expect(deserialized.messages[0].content).toBe('Hello');
      expect(deserialized.messages[1].content).toBe('Hi there!');
    });

    it('should round-trip a comparison conversation with model identity on messages', () => {
      const conversation: Conversation = {
        id: '2024-01-15-1430-abcd-compare',
        created: '2024-01-15T14:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Hello' },
          {
            role: 'assistant',
            timestamp: '2024-01-15T14:30:05.000Z',
            content: 'Hi from Haiku!',
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
          },
          {
            role: 'assistant',
            timestamp: '2024-01-15T14:30:05.000Z',
            content: 'Hi from Sonnet!',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
          },
        ],
        comparison: {
          isComparison: true,
          models: [
            { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
            { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
          ],
        },
      };

      const yaml = serializeConversation(conversation);
      const deserialized = deserializeConversation(yaml);

      expect(deserialized.comparison).toBeDefined();
      expect(deserialized.comparison?.isComparison).toBe(true);
      expect(deserialized.comparison?.models).toHaveLength(2);
      expect(deserialized.messages[1].provider).toBe('anthropic');
      expect(deserialized.messages[1].model).toBe('claude-haiku-4-5-20251001');
      expect(deserialized.messages[2].provider).toBe('anthropic');
      expect(deserialized.messages[2].model).toBe('claude-sonnet-4-5-20250929');
    });

    it('should filter out empty messages during serialization', () => {
      const conversation: Conversation = {
        id: '2024-01-15-1430-abcd-test',
        created: '2024-01-15T14:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101',
        messages: [
          { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Hello' },
          { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: '' }, // Empty, should be filtered
          { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: '  ' }, // Whitespace only, should be filtered
          { role: 'assistant', timestamp: '2024-01-15T14:30:10.000Z', content: 'Valid response' },
        ],
      };

      const yaml = serializeConversation(conversation);
      const deserialized = deserializeConversation(yaml);

      expect(deserialized.messages).toHaveLength(2);
      expect(deserialized.messages[0].content).toBe('Hello');
      expect(deserialized.messages[1].content).toBe('Valid response');
    });
  });

  describe('validateComparisonConversation', () => {
    it('should validate a proper comparison conversation', () => {
      const conversation: Conversation = {
        id: '2024-01-15-1430-abcd-compare',
        created: '2024-01-15T14:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Hello' },
          {
            role: 'assistant',
            timestamp: '2024-01-15T14:30:05.000Z',
            content: 'Response 1',
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
          },
          {
            role: 'assistant',
            timestamp: '2024-01-15T14:30:05.000Z',
            content: 'Response 2',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
          },
        ],
        comparison: {
          isComparison: true,
          models: [
            { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
            { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
          ],
        },
      };

      const result = validateComparisonConversation(conversation);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject conversation without comparison metadata', () => {
      const conversation: Conversation = {
        id: '2024-01-15-1430-abcd-test',
        created: '2024-01-15T14:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101',
        messages: [],
      };

      const result = validateComparisonConversation(conversation);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing comparison metadata');
    });

    it('should warn about assistant messages without model identity', () => {
      const conversation: Conversation = {
        id: '2024-01-15-1430-abcd-compare',
        created: '2024-01-15T14:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Hello' },
          { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'Response 1' }, // No provider/model
          { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'Response 2' }, // No provider/model
        ],
        comparison: {
          isComparison: true,
          models: [
            { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
            { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
          ],
        },
      };

      const result = validateComparisonConversation(conversation);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('2 assistant message(s) without provider/model identity');
    });
  });

  describe('groupMessagesByPrompt', () => {
    it('should group messages correctly for 2 models', () => {
      const messages: Message[] = [
        { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Question 1' },
        {
          role: 'assistant',
          timestamp: '2024-01-15T14:30:05.000Z',
          content: 'Answer 1a',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
        },
        {
          role: 'assistant',
          timestamp: '2024-01-15T14:30:05.000Z',
          content: 'Answer 1b',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
        },
        { role: 'user', timestamp: '2024-01-15T14:35:00.000Z', content: 'Question 2' },
        {
          role: 'assistant',
          timestamp: '2024-01-15T14:35:05.000Z',
          content: 'Answer 2a',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
        },
        {
          role: 'assistant',
          timestamp: '2024-01-15T14:35:05.000Z',
          content: 'Answer 2b',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
        },
      ];

      const groups = groupMessagesByPrompt(messages, 2);

      expect(groups).toHaveLength(2);
      expect(groups[0].userMessage).toBe('Question 1');
      expect(groups[0].responses).toHaveLength(2);
      expect(groups[0].responses[0].content).toBe('Answer 1a');
      expect(groups[0].responses[0].provider).toBe('anthropic');
      expect(groups[0].responses[0].model).toBe('claude-haiku-4-5-20251001');
      expect(groups[0].responses[1].content).toBe('Answer 1b');
      expect(groups[0].responses[1].model).toBe('claude-sonnet-4-5-20250929');

      expect(groups[1].userMessage).toBe('Question 2');
      expect(groups[1].responses).toHaveLength(2);
    });

    it('should handle old conversations without provider/model on messages', () => {
      const messages: Message[] = [
        { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Question 1' },
        { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'Answer 1a' },
        { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'Answer 1b' },
      ];

      const groups = groupMessagesByPrompt(messages, 2);

      expect(groups).toHaveLength(1);
      expect(groups[0].responses).toHaveLength(2);
      expect(groups[0].responses[0].provider).toBeUndefined();
      expect(groups[0].responses[0].model).toBeUndefined();
    });

    it('should handle 3 models', () => {
      const messages: Message[] = [
        { role: 'user', timestamp: '2024-01-15T14:30:00.000Z', content: 'Question' },
        { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'A', provider: 'anthropic', model: 'm1' },
        { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'B', provider: 'openai', model: 'm2' },
        { role: 'assistant', timestamp: '2024-01-15T14:30:05.000Z', content: 'C', provider: 'ollama', model: 'm3' },
      ];

      const groups = groupMessagesByPrompt(messages, 3);

      expect(groups).toHaveLength(1);
      expect(groups[0].responses).toHaveLength(3);
    });
  });

  describe('getModelDisplayName', () => {
    it('should use provider/model from message when available', () => {
      const response = { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001' };
      const name = getModelDisplayName(response, 0);
      expect(name).toBe('anthropic/claude-haiku-4-5-20251001');
    });

    it('should fall back to comparison metadata when message lacks identity', () => {
      const response = {}; // No provider/model
      const comparisonModels = [
        { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001' },
        { provider: 'anthropic' as const, model: 'claude-sonnet-4-5-20250929' },
      ];

      const name0 = getModelDisplayName(response, 0, comparisonModels);
      expect(name0).toBe('anthropic/claude-haiku-4-5-20251001');

      const name1 = getModelDisplayName(response, 1, comparisonModels);
      expect(name1).toBe('anthropic/claude-sonnet-4-5-20250929');
    });

    it('should use generic fallback when no identity available', () => {
      const response = {};
      const name = getModelDisplayName(response, 2);
      expect(name).toBe('Model 3');
    });
  });

  describe('createComparisonConversation', () => {
    it('should create a valid comparison conversation', () => {
      const models = [
        { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001' },
        { provider: 'openai' as const, model: 'gpt-4o' },
      ];

      const conversation = createComparisonConversation(models);

      expect(conversation.id).toMatch(/-compare$/);
      expect(conversation.comparison).toBeDefined();
      expect(conversation.comparison?.isComparison).toBe(true);
      expect(conversation.comparison?.models).toHaveLength(2);
      expect(conversation.provider).toBe('anthropic');
      expect(conversation.model).toBe('claude-haiku-4-5-20251001');
      expect(conversation.messages).toHaveLength(0);
    });
  });

  describe('createComparisonAssistantMessages', () => {
    it('should create messages with provider/model identity', () => {
      const responses = [
        { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', content: 'Response A' },
        { provider: 'openai' as const, model: 'gpt-4o', content: 'Response B' },
      ];

      const messages = createComparisonAssistantMessages(responses);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('Response A');
      expect(messages[0].provider).toBe('anthropic');
      expect(messages[0].model).toBe('claude-haiku-4-5-20251001');
      expect(messages[1].provider).toBe('openai');
      expect(messages[1].model).toBe('gpt-4o');
    });
  });

  describe('YAML format compatibility', () => {
    it('should correctly deserialize the actual problematic YAML format', () => {
      // This is the format from the user's actual file that wasn't working
      const yamlContent = `id: 2026-01-13-2322-8d13-compare
created: '2026-01-13T07:22:44.973Z'
provider: anthropic
model: claude-haiku-4-5-20251001
messages:
  - role: user
    timestamp: '2026-01-13T07:22:48.148Z'
    content: helo frnds
  - role: assistant
    timestamp: '2026-01-13T07:22:50.195Z'
    content: Hey there. What's on your mind?
  - role: assistant
    timestamp: '2026-01-13T07:22:50.195Z'
    content: Hey! What's up?
comparison:
  isComparison: true
  models:
    - provider: anthropic
      model: claude-haiku-4-5-20251001
    - provider: anthropic
      model: claude-sonnet-4-5-20250929
`;

      const conversation = deserializeConversation(yamlContent);

      expect(conversation.id).toBe('2026-01-13-2322-8d13-compare');
      expect(conversation.comparison).toBeDefined();
      expect(conversation.comparison?.isComparison).toBe(true);
      expect(conversation.comparison?.models).toHaveLength(2);
      expect(conversation.messages).toHaveLength(3);

      // The old format doesn't have provider/model on messages
      expect(conversation.messages[1].provider).toBeUndefined();
      expect(conversation.messages[1].model).toBeUndefined();

      // But we can still group and display using comparison metadata
      const groups = groupMessagesByPrompt(conversation.messages, 2);
      expect(groups).toHaveLength(1);
      expect(groups[0].responses).toHaveLength(2);

      // And get display names from comparison metadata
      const displayName0 = getModelDisplayName(
        groups[0].responses[0],
        0,
        conversation.comparison?.models
      );
      expect(displayName0).toBe('anthropic/claude-haiku-4-5-20251001');

      const displayName1 = getModelDisplayName(
        groups[0].responses[1],
        1,
        conversation.comparison?.models
      );
      expect(displayName1).toBe('anthropic/claude-sonnet-4-5-20250929');
    });

    it('should correctly serialize and deserialize the new format with model identity', () => {
      const yamlContent = `id: 2026-01-13-2322-8d13-compare
created: '2026-01-13T07:22:44.973Z'
provider: anthropic
model: claude-haiku-4-5-20251001
messages:
  - role: user
    timestamp: '2026-01-13T07:22:48.148Z'
    content: helo frnds
  - role: assistant
    timestamp: '2026-01-13T07:22:50.195Z'
    content: Hey there. What's on your mind?
    provider: anthropic
    model: claude-haiku-4-5-20251001
  - role: assistant
    timestamp: '2026-01-13T07:22:50.195Z'
    content: Hey! What's up?
    provider: anthropic
    model: claude-sonnet-4-5-20250929
comparison:
  isComparison: true
  models:
    - provider: anthropic
      model: claude-haiku-4-5-20251001
    - provider: anthropic
      model: claude-sonnet-4-5-20250929
`;

      const conversation = deserializeConversation(yamlContent);

      // New format has provider/model on messages
      expect(conversation.messages[1].provider).toBe('anthropic');
      expect(conversation.messages[1].model).toBe('claude-haiku-4-5-20251001');
      expect(conversation.messages[2].provider).toBe('anthropic');
      expect(conversation.messages[2].model).toBe('claude-sonnet-4-5-20250929');

      // Display names come directly from messages
      const groups = groupMessagesByPrompt(conversation.messages, 2);
      const displayName0 = getModelDisplayName(groups[0].responses[0], 0);
      expect(displayName0).toBe('anthropic/claude-haiku-4-5-20251001');
    });
  });
});
