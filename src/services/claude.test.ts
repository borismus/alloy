import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeService } from './claude';
import Anthropic from '@anthropic-ai/sdk';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockClient = {
    messages: {
      create: vi.fn(),
    },
  };

  return {
    default: vi.fn(function(this: any) {
      return mockClient;
    }),
  };
});

describe('ClaudeService', () => {
  let claudeService: ClaudeService;
  let mockClient: any;

  beforeEach(() => {
    claudeService = new ClaudeService();
    vi.clearAllMocks();

    // Get reference to the mock client
    mockClient = {
      messages: {
        create: vi.fn(),
      },
    };

    // Mock the Anthropic constructor to return our mock client
    vi.mocked(Anthropic).mockImplementation(function(this: any) {
      return mockClient;
    } as any);
  });

  describe('initialize', () => {
    it('should initialize client with API key', () => {
      claudeService.initialize('test-api-key');

      expect(Anthropic).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        dangerouslyAllowBrowser: true,
      });
    });

    it('should use default model if not specified', () => {
      claudeService.initialize('test-api-key');

      // Model should be set to default
      // We'll verify this in sendMessage tests
      expect(Anthropic).toHaveBeenCalled();
    });

    it('should use custom model if specified', () => {
      claudeService.initialize('test-api-key', 'claude-opus-4-5-20251101');

      // Model will be verified in sendMessage tests
      expect(Anthropic).toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      claudeService.initialize('test-api-key');
    });

    it('should throw error if client not initialized', async () => {
      const uninitializedService = new ClaudeService();

      await expect(
        uninitializedService.sendMessage([{ role: 'user', content: 'Hello', timestamp: '2024-01-01T10:00:00Z' }])
      ).rejects.toThrow('Claude client not initialized. Please provide an API key.');
    });

    it('should send messages to API and return response', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      // Mock streaming response
      const mockStream = (async function* () {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' },
        };
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'there!' },
        };
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await claudeService.sendMessage(messages);

      expect(result).toBe('Hello there!');
      expect(mockClient.messages.create).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'Hello' }],
        system: undefined,
        stream: true,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          },
        ],
      });
    });

    it('should include system prompt when provided', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];
      const systemPrompt = 'You are a helpful assistant.';

      const mockStream = (async function* () {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Response' },
        };
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      await claudeService.sendMessage(messages, systemPrompt);

      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: systemPrompt,
        })
      );
    });

    it('should call onChunk callback for each text chunk', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];
      const onChunk = vi.fn();

      const mockStream = (async function* () {
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
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await claudeService.sendMessage(messages, undefined, onChunk);

      expect(result).toBe('First second third');
      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(onChunk).toHaveBeenNthCalledWith(1, 'First ');
      expect(onChunk).toHaveBeenNthCalledWith(2, 'second ');
      expect(onChunk).toHaveBeenNthCalledWith(3, 'third');
    });

    it('should ignore non-text-delta chunks', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const mockStream = (async function* () {
        yield {
          type: 'content_block_start',
          index: 0,
        };
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Text' },
        };
        yield {
          type: 'content_block_stop',
          index: 0,
        };
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      const result = await claudeService.sendMessage(messages);

      expect(result).toBe('Text');
    });

    it('should handle streaming errors', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const mockStream = (async function* () {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Start ' },
        };
        throw new Error('Stream error');
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      await expect(claudeService.sendMessage(messages)).rejects.toThrow('Stream error');
    });

    it('should convert message format correctly', async () => {
      const messages = [
        { role: 'user' as const, content: 'First message', timestamp: '2024-01-01T10:00:00Z' },
        { role: 'assistant' as const, content: 'Response', timestamp: '2024-01-01T10:01:00Z' },
        { role: 'user' as const, content: 'Second message', timestamp: '2024-01-01T10:02:00Z' },
      ];

      const mockStream = (async function* () {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'OK' },
        };
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      await claudeService.sendMessage(messages);

      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'First message' },
            { role: 'assistant', content: 'Response' },
            { role: 'user', content: 'Second message' },
          ],
        })
      );
    });

    it('should use custom model when initialized with one', async () => {
      const customService = new ClaudeService();
      customService.initialize('test-api-key', 'claude-opus-4-5-20251101');

      const messages = [
        { role: 'user' as const, content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
      ];

      const mockStream = (async function* () {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Response' },
        };
      })();

      mockClient.messages.create.mockResolvedValue(mockStream);

      await customService.sendMessage(messages);

      expect(mockClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-5-20251101',
        })
      );
    });
  });
});
