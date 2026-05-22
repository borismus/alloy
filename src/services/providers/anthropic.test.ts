import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicService } from './anthropic';
import Anthropic from '@anthropic-ai/sdk';

// Create mock client that will be shared
const mockClient = {
  messages: {
    create: vi.fn(),
  },
};

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn(function () {
      return mockClient;
    }),
  };
});

describe('AnthropicService', () => {
  let service: AnthropicService;

  beforeEach(() => {
    service = new AnthropicService();
    vi.clearAllMocks();
  });

  describe('providerType', () => {
    it('should return anthropic as provider type', () => {
      expect(service.providerType).toBe('anthropic');
    });
  });

  describe('initialize', () => {
    it('should initialize client with API key', () => {
      service.initialize('test-api-key');

      expect(Anthropic).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        dangerouslyAllowBrowser: true,
        fetch: expect.any(Function),
      });
    });

    it('should set isInitialized to true after initialization', () => {
      expect(service.isInitialized()).toBe(false);
      service.initialize('test-api-key');
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('isInitialized', () => {
    it('should return false before initialization', () => {
      expect(service.isInitialized()).toBe(false);
    });

    it('should return true after initialization', () => {
      service.initialize('test-api-key');
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('getAvailableModels', () => {
    it('should return list of Anthropic models', () => {
      const models = service.getAvailableModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.key.startsWith('anthropic/'))).toBe(true);
      expect(models.every((m) => m.key && m.name)).toBe(true);
    });

    it('should include expected model keys', () => {
      const models = service.getAvailableModels();
      const modelKeys = models.map((m) => m.key);

      expect(modelKeys).toContain('anthropic/claude-opus-4-7');
      expect(modelKeys).toContain('anthropic/claude-sonnet-4-6');
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      service.initialize('test-api-key');
    });

    it('should throw error if client not initialized', async () => {
      const uninitializedService = new AnthropicService();

      await expect(
        uninitializedService.sendMessage(
          [{ role: 'user', content: 'Hello', timestamp: '2024-01-01T10:00:00Z' }],
          { model: 'claude-sonnet-4-20250514' }
        )
      ).rejects.toThrow('Anthropic client not initialized. Please provide an API key.');
    });

    it('should send messages to API and return response', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      // Mock streaming response
      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello ' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'there!' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await service.sendMessage(messages, {
        model: 'claude-sonnet-4-20250514',
      });

      expect(result.content).toBe('Hello there!');
      expect(mockClient.messages.create).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'Hello' }],
        system: undefined, // No system prompt → no cached system block
        stream: true,
        tools: undefined,
      });
    });

    it('should include system prompt when provided', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];
      const systemPrompt = 'You are a helpful assistant.';

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Response' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      await service.sendMessage(messages, {
        model: 'claude-sonnet-4-20250514',
        systemPrompt,
      });

      // System prompt is wrapped in a cache-marked text block
      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          ],
        })
      );
    });

    it('should call onChunk callback for each text chunk', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];
      const onChunk = vi.fn();

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'First ' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'second ' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'third' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await service.sendMessage(messages, {
        model: 'claude-sonnet-4-20250514',
        onChunk,
      });

      expect(result.content).toBe('First second third');
      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(onChunk).toHaveBeenNthCalledWith(1, 'First ');
      expect(onChunk).toHaveBeenNthCalledWith(2, 'second ');
      expect(onChunk).toHaveBeenNthCalledWith(3, 'third');
    });

    it('should ignore non-text-delta chunks', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Text' },
          };
          yield {
            type: 'content_block_stop',
            index: 0,
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await service.sendMessage(messages, {
        model: 'claude-sonnet-4-20250514',
      });

      expect(result.content).toBe('Text');
    });

    it('should filter out log messages', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
        { role: 'log' as const, content: 'System log', timestamp: '2024-01-01T10:00:01Z' },
        { role: 'assistant' as const, content: 'Hi there', timestamp: '2024-01-01T10:00:02Z' },
        { role: 'user' as const, content: 'How are you?', timestamp: '2024-01-01T10:00:03Z' },
      ];

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Good!' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      await service.sendMessage(messages, { model: 'claude-sonnet-4-20250514' });

      // Second-to-last user message ('Hello') gets a cache breakpoint on its last block
      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
              ],
            },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'How are you?' },
          ],
        })
      );
    });

    it('should handle streaming errors', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Start ' },
          };
          throw new Error('Stream error');
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      await expect(
        service.sendMessage(messages, { model: 'claude-sonnet-4-20250514' })
      ).rejects.toThrow('Stream error');
    });

    it('should convert message format correctly', async () => {
      const messages = [
        { role: 'user' as const, content: 'First message', timestamp: '2024-01-01T10:00:00Z' },
        { role: 'assistant' as const, content: 'Response', timestamp: '2024-01-01T10:01:00Z' },
        { role: 'user' as const, content: 'Second message', timestamp: '2024-01-01T10:02:00Z' },
      ];

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'OK' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      await service.sendMessage(messages, { model: 'claude-sonnet-4-20250514' });

      // Second-to-last user message ('First message') gets a cache breakpoint
      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'First message', cache_control: { type: 'ephemeral' } },
              ],
            },
            { role: 'assistant', content: 'Response' },
            { role: 'user', content: 'Second message' },
          ],
        })
      );
    });

    it('should use the model specified in options', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const mockStream = {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Response' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      await service.sendMessage(messages, { model: 'claude-opus-4-5-20251101' });

      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-5-20251101',
        })
      );
    });

    it('should abort stream when signal is aborted', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const abortController = new AbortController();
      const mockAbort = vi.fn();

      const mockStream = {
        controller: { abort: mockAbort },
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'First ' },
          };
          // Simulate abort after first chunk
          abortController.abort();
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Second' },
          };
        },
      };

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await service.sendMessage(messages, {
        model: 'claude-sonnet-4-20250514',
        signal: abortController.signal,
      });

      expect(result.content).toBe('First ');
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe('prompt caching', () => {
    beforeEach(() => {
      service.initialize('test-api-key');
    });

    function streamYielding(text: string, usage?: Record<string, number>) {
      return {
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: async function* () {
          if (usage) {
            yield {
              type: 'message_start',
              message: { id: 'msg_1', usage },
            };
          }
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text },
          };
        },
      };
    }

    it('does not add a message cache breakpoint when there is only one user message', async () => {
      mockClient.messages.create.mockResolvedValue(streamYielding('hi'));

      await service.sendMessage(
        [{ role: 'user', content: 'Hello', timestamp: '2024-01-01T10:00:00Z' }],
        { model: 'claude-sonnet-4-6' },
      );

      const call = mockClient.messages.create.mock.calls[0][0];
      // Single user message stays as plain string
      expect(call.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('adds a cache breakpoint to the second-to-last user message in a multi-turn conversation', async () => {
      mockClient.messages.create.mockResolvedValue(streamYielding('ok'));

      await service.sendMessage(
        [
          { role: 'user', content: 'turn 1 user', timestamp: 't1' },
          { role: 'assistant', content: 'turn 1 reply', timestamp: 't2' },
          { role: 'user', content: 'turn 2 user', timestamp: 't3' },
          { role: 'assistant', content: 'turn 2 reply', timestamp: 't4' },
          { role: 'user', content: 'turn 3 user', timestamp: 't5' },
        ],
        { model: 'claude-sonnet-4-6' },
      );

      const call = mockClient.messages.create.mock.calls[0][0];
      // 'turn 2 user' is the second-to-last user message → gets the cache marker
      expect(call.messages[2]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'turn 2 user', cache_control: { type: 'ephemeral' } },
        ],
      });
      // The most recent user message stays uncached so the next turn extends the cache
      expect(call.messages[4]).toEqual({ role: 'user', content: 'turn 3 user' });
    });

    it('caches the system prompt when provided', async () => {
      mockClient.messages.create.mockResolvedValue(streamYielding('ok'));

      await service.sendMessage(
        [{ role: 'user', content: 'hi', timestamp: 't1' }],
        { model: 'claude-sonnet-4-6', systemPrompt: 'You are Alloy.' },
      );

      const call = mockClient.messages.create.mock.calls[0][0];
      expect(call.system).toEqual([
        { type: 'text', text: 'You are Alloy.', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('captures cache_read and cache_creation tokens from the streaming response', async () => {
      mockClient.messages.create.mockResolvedValue(
        streamYielding('ok', {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 50,
        }),
      );

      const result = await service.sendMessage(
        [{ role: 'user', content: 'hi', timestamp: 't1' }],
        { model: 'claude-sonnet-4-6' },
      );

      expect(result.usage?.inputTokens).toBe(100);
      expect(result.usage?.cachedInputTokens).toBe(4000);
      expect(result.usage?.cacheCreationInputTokens).toBe(50);
    });
  });

  describe('generateTitle', () => {
    it('should return truncated user message if client not initialized', async () => {
      const uninitializedService = new AnthropicService();

      const longMessage = 'This is a long user message that should be truncated to 50 characters';
      const title = await uninitializedService.generateTitle(
        longMessage,
        'Assistant response'
      );

      // generateTitle truncates to 50 chars when falling back
      expect(title).toBe(longMessage.slice(0, 50));
      expect(title.length).toBe(50);
    });

    it('should generate title using Haiku model', async () => {
      service.initialize('test-api-key');

      mockClient.messages.create.mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Generated Title' }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const title = await service.generateTitle('User message', 'Assistant response');

      expect(title).toBe('Generated Title');
      expect(mockClient.messages.create).toHaveBeenCalledWith({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: expect.stringContaining('Generate a short, descriptive title'),
          },
        ],
      });
    });

    it('should include user message and assistant response in prompt', async () => {
      service.initialize('test-api-key');

      mockClient.messages.create.mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Title' }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      await service.generateTitle('Hello world', 'Hi there!');

      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: expect.stringContaining('Hello world'),
            },
          ],
        })
      );
      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: expect.stringContaining('Hi there!'),
            },
          ],
        })
      );
    });

    it('should truncate long messages in prompt', async () => {
      service.initialize('test-api-key');

      mockClient.messages.create.mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Title' }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const longMessage = 'a'.repeat(1000);
      await service.generateTitle(longMessage, longMessage);

      const call = mockClient.messages.create.mock.calls[0][0];
      const prompt = call.messages[0].content;

      // Each message should be sliced to 500 chars
      expect(prompt.match(/a{500}/g)?.length).toBe(2);
      expect(prompt).not.toContain('a'.repeat(501));
    });

    it('should trim whitespace from generated title', async () => {
      service.initialize('test-api-key');

      mockClient.messages.create.mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: '  Spaced Title  \n' }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const title = await service.generateTitle('User', 'Assistant');

      expect(title).toBe('Spaced Title');
    });

    it('should truncate title to 100 characters', async () => {
      service.initialize('test-api-key');

      const longTitle = 'A'.repeat(150);
      mockClient.messages.create.mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: longTitle }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const title = await service.generateTitle('User', 'Assistant');

      expect(title.length).toBe(100);
    });

    it('should fallback to truncated user message on error', async () => {
      service.initialize('test-api-key');

      mockClient.messages.create.mockRejectedValue(new Error('API Error'));

      const title = await service.generateTitle(
        'This is the user message',
        'Assistant response'
      );

      expect(title).toBe('This is the user message');
    });

    it('should fallback if response has no text block', async () => {
      service.initialize('test-api-key');

      mockClient.messages.create.mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'tool_use', id: '123', name: 'test', input: {} }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const title = await service.generateTitle('User message here', 'Response');

      expect(title).toBe('User message here');
    });
  });
});
