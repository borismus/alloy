import { describe, it, expect } from 'vitest';
import { ContextManager } from './manager';
import { estimateTokens, estimateMessageTokens, estimateToolTokens, truncateToTokenBudget } from './estimator';
import type { Message } from '../../types';
import type { ToolDefinition } from '../../types/tools';

// Helper to create messages
function msg(role: 'user' | 'assistant' | 'log', content: string, extras?: Partial<Message>): Message {
  return { role, content, timestamp: '2024-01-01T10:00:00Z', ...extras };
}

describe('estimator', () => {
  describe('estimateTokens', () => {
    it('estimates ~4 chars per token', () => {
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcdefgh')).toBe(2);
      expect(estimateTokens('a')).toBe(1); // ceil(1/4) = 1
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });
  });

  describe('estimateMessageTokens', () => {
    it('includes content + 10 overhead', () => {
      const tokens = estimateMessageTokens(msg('user', 'abcd'));
      // ceil(4/4) + 10 = 11
      expect(tokens).toBe(11);
    });

    it('adds 1000 per attachment', () => {
      const m = msg('user', 'test', {
        attachments: [{ type: 'image' as const, path: 'img.png', mimeType: 'image/png' }],
      });
      const tokens = estimateMessageTokens(m);
      expect(tokens).toBeGreaterThanOrEqual(1010);
    });

    it('adds tool use result tokens + 20 overhead per tool', () => {
      const m = msg('assistant', 'result', {
        toolUse: [{ type: 'read_file', input: {}, result: 'a'.repeat(400) }],
      });
      const tokens = estimateMessageTokens(m);
      // content: ceil(6/4)=2, overhead: 10, tool result: ceil(400/4)=100, tool overhead: 20
      expect(tokens).toBe(2 + 10 + 100 + 20);
    });
  });

  describe('estimateToolTokens', () => {
    it('estimates tokens from tool definition strings', () => {
      const tools: ToolDefinition[] = [{
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] },
      }];
      const tokens = estimateToolTokens(tools);
      expect(tokens).toBeGreaterThan(0);
    });

    it('returns 0 for empty tool list', () => {
      expect(estimateToolTokens([])).toBe(0);
    });
  });

  describe('truncateToTokenBudget', () => {
    it('returns text unchanged when under budget', () => {
      expect(truncateToTokenBudget('short text', 1000)).toBe('short text');
    });

    it('truncates from start when over budget', () => {
      const longText = 'a'.repeat(1000);
      const result = truncateToTokenBudget(longText, 10); // 10 tokens = ~40 chars
      expect(result.length).toBeLessThan(1000);
      expect(result).toContain('[...truncated...]');
    });

    it('preserves the end of the text', () => {
      const text = 'START' + 'x'.repeat(1000) + 'END';
      const result = truncateToTokenBudget(text, 20);
      expect(result).toContain('END');
    });
  });
});

describe('ContextManager', () => {
  describe('calculateBudget', () => {
    it('returns correct budget breakdown', () => {
      const cm = new ContextManager({ totalBudget: 10000, responseReserve: 2000 });
      const budget = cm.calculateBudget('system prompt here', []);
      expect(budget.total).toBe(10000);
      expect(budget.response).toBe(2000);
      expect(budget.systemPrompt).toBe(estimateTokens('system prompt here'));
      expect(budget.tools).toBe(0);
      expect(budget.messages).toBe(10000 - budget.systemPrompt - 2000);
    });

    it('messages budget never goes negative', () => {
      const cm = new ContextManager({ totalBudget: 100, responseReserve: 100 });
      const budget = cm.calculateBudget('a'.repeat(1000), []);
      expect(budget.messages).toBe(0);
    });
  });

  describe('prepareContext', () => {
    const cm = new ContextManager({ totalBudget: 16000, responseReserve: 4000 });

    it('returns empty for no messages', () => {
      const budget = cm.calculateBudget('', []);
      const result = cm.prepareContext([], budget);
      expect(result.messages).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(result.truncatedCount).toBe(0);
    });

    it('filters out log messages', () => {
      const budget = cm.calculateBudget('', []);
      const messages = [
        msg('user', 'hello'),
        msg('log', 'system event'),
        msg('assistant', 'hi'),
      ];
      const result = cm.prepareContext(messages, budget);
      expect(result.messages.every(m => m.role !== 'log')).toBe(true);
      expect(result.messages).toHaveLength(2);
    });

    it('always includes the newest message', () => {
      const budget = cm.calculateBudget('', []);
      const messages = [
        msg('user', 'first'),
        msg('assistant', 'second'),
        msg('user', 'third'),
      ];
      const result = cm.prepareContext(messages, budget);
      expect(result.messages[result.messages.length - 1].content).toBe('third');
    });

    it('drops oldest messages when over budget', () => {
      // Tight budget: only room for ~1-2 short messages
      const cm2 = new ContextManager({ totalBudget: 200, responseReserve: 100 });
      const budget = cm2.calculateBudget('', []);
      // budget.messages = 100 tokens = ~400 chars

      const messages = [
        msg('user', 'a'.repeat(200)),     // 50 tokens + 10 overhead
        msg('assistant', 'b'.repeat(200)), // 50 tokens + 10 overhead
        msg('user', 'c'.repeat(200)),      // 50 tokens + 10 overhead
      ];
      const result = cm2.prepareContext(messages, budget);

      // Should have dropped at least one old message
      expect(result.truncatedCount).toBeGreaterThan(0);
      expect(result.truncated).toBe(true);
      // Newest is always included
      expect(result.messages[result.messages.length - 1].content).toBe('c'.repeat(200));
    });

    it('truncates newest message content when it alone exceeds budget', () => {
      const cm2 = new ContextManager({ totalBudget: 200, responseReserve: 100 });
      const budget = cm2.calculateBudget('', []);
      // budget.messages = 100 tokens = ~400 chars

      const messages = [
        msg('user', 'x'.repeat(2000)), // way over budget
      ];
      const result = cm2.prepareContext(messages, budget);

      expect(result.contentTruncated).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.length).toBeLessThan(2000);
    });

    it('returns messages in chronological order', () => {
      const budget = cm.calculateBudget('', []);
      const messages = [
        msg('user', 'first'),
        msg('assistant', 'second'),
        msg('user', 'third'),
      ];
      const result = cm.prepareContext(messages, budget);
      expect(result.messages.map(m => m.content)).toEqual(['first', 'second', 'third']);
    });

    it('truncates long tool results', () => {
      const cm2 = new ContextManager({ toolResultMaxTokens: 50 }); // 50 tokens = ~200 chars max
      const budget = cm2.calculateBudget('', []);

      const messages = [
        msg('assistant', 'result', {
          toolUse: [{ type: 'read_file', input: {}, result: 'x'.repeat(1000) }],
        }),
      ];
      const result = cm2.prepareContext(messages, budget);
      const toolResult = result.messages[0].toolUse![0].result!;
      expect(toolResult.length).toBeLessThan(1000);
      expect(toolResult).toContain('[...truncated...]');
    });
  });

  describe('custom config', () => {
    it('overrides default budget', () => {
      const cm = new ContextManager({ totalBudget: 5000 });
      const budget = cm.calculateBudget('', []);
      expect(budget.total).toBe(5000);
    });

    it('overrides response reserve', () => {
      const cm = new ContextManager({ responseReserve: 1000 });
      const budget = cm.calculateBudget('', []);
      expect(budget.response).toBe(1000);
    });
  });
});
