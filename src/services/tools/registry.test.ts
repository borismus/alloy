import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from './registry';
import { BUILTIN_TOOLS } from '../../types/tools';

// Mock all builtin executors
vi.mock('./builtin/files', () => ({
  executeFileTools: vi.fn(),
}));
vi.mock('./builtin/http', () => ({
  executeHttpTools: vi.fn(),
}));
vi.mock('./builtin/secrets', () => ({
  executeSecretTools: vi.fn(),
}));
vi.mock('./builtin/skills', () => ({
  executeSkillTools: vi.fn(),
}));
vi.mock('./builtin/search', () => ({
  executeSearchTools: vi.fn(),
}));
vi.mock('./builtin/websearch', () => ({
  executeWebSearchTools: vi.fn(),
}));

import { executeFileTools } from './builtin/files';
import { executeHttpTools } from './builtin/http';
import { executeSecretTools } from './builtin/secrets';
import { executeSkillTools } from './builtin/skills';
import { executeSearchTools } from './builtin/search';
import { executeWebSearchTools } from './builtin/websearch';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
  });

  describe('getToolDefinitions', () => {
    it('returns all builtin tools', () => {
      const tools = registry.getToolDefinitions();
      expect(tools).toHaveLength(BUILTIN_TOOLS.length);
      for (const builtin of BUILTIN_TOOLS) {
        expect(tools.find(t => t.name === builtin.name)).toBeDefined();
      }
    });
  });

  describe('getTool', () => {
    it('returns tool by name', () => {
      const tool = registry.getTool('read_file');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('read_file');
    });

    it('returns undefined for unknown tool', () => {
      expect(registry.getTool('nonexistent_tool')).toBeUndefined();
    });
  });

  describe('executeTool', () => {
    it('returns error for unknown tool', async () => {
      const result = await registry.executeTool({
        id: 'call-1',
        name: 'fake_tool',
        input: {},
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Unknown tool: fake_tool');
      expect(result.tool_use_id).toBe('call-1');
    });

    it('routes read_file to executeFileTools', async () => {
      vi.mocked(executeFileTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'file contents',
      });

      const result = await registry.executeTool({
        id: 'call-2',
        name: 'read_file',
        input: { path: 'notes/test.md' },
      });

      expect(executeFileTools).toHaveBeenCalledWith('read_file', expect.objectContaining({ path: 'notes/test.md' }));
      expect(result.content).toBe('file contents');
      expect(result.tool_use_id).toBe('call-2');
    });

    it('routes write_file to executeFileTools', async () => {
      vi.mocked(executeFileTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'written',
      });

      await registry.executeTool({
        id: 'call-3',
        name: 'write_file',
        input: { path: 'triggers/test.yaml', content: 'data' },
      });

      expect(executeFileTools).toHaveBeenCalledWith('write_file', expect.anything());
    });

    it('routes append_to_note to executeFileTools', async () => {
      vi.mocked(executeFileTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'appended',
      });

      await registry.executeTool({
        id: 'call-4',
        name: 'append_to_note',
        input: { path: 'notes/note.md', content: 'new line' },
      });

      expect(executeFileTools).toHaveBeenCalled();
    });

    it('routes http_get to executeHttpTools', async () => {
      vi.mocked(executeHttpTools).mockResolvedValue({
        tool_use_id: 'x',
        content: '{"ok":true}',
      });

      await registry.executeTool({
        id: 'call-5',
        name: 'http_get',
        input: { url: 'https://example.com' },
      });

      expect(executeHttpTools).toHaveBeenCalledWith('http_get', { url: 'https://example.com' });
    });

    it('routes get_secret to executeSecretTools', async () => {
      vi.mocked(executeSecretTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'secret-value',
      });

      await registry.executeTool({
        id: 'call-6',
        name: 'get_secret',
        input: { name: 'API_KEY' },
      });

      expect(executeSecretTools).toHaveBeenCalledWith('get_secret', { name: 'API_KEY' });
    });

    it('routes use_skill to executeSkillTools', async () => {
      vi.mocked(executeSkillTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'skill instructions',
      });

      await registry.executeTool({
        id: 'call-7',
        name: 'use_skill',
        input: { name: 'my-skill' },
      });

      expect(executeSkillTools).toHaveBeenCalledWith('use_skill', { name: 'my-skill' });
    });

    it('routes search_directory to executeSearchTools', async () => {
      vi.mocked(executeSearchTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'search results',
      });

      await registry.executeTool({
        id: 'call-8',
        name: 'search_directory',
        input: { query: 'test', directory: 'notes' },
      });

      expect(executeSearchTools).toHaveBeenCalledWith('search_directory', expect.anything());
    });

    it('routes web_search to executeWebSearchTools', async () => {
      vi.mocked(executeWebSearchTools).mockResolvedValue({
        tool_use_id: 'x',
        content: 'web results',
      });

      await registry.executeTool({
        id: 'call-9',
        name: 'web_search',
        input: { query: 'test query' },
      });

      expect(executeWebSearchTools).toHaveBeenCalledWith('web_search', { query: 'test query' });
    });

    describe('context injection', () => {
      it('injects messageId into file tool input', async () => {
        vi.mocked(executeFileTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'c1', name: 'read_file', input: { path: 'notes/a.md' } },
          { messageId: 'msg-123' },
        );

        expect(executeFileTools).toHaveBeenCalledWith(
          'read_file',
          expect.objectContaining({ _messageId: 'msg-123' }),
        );
      });

      it('injects conversationId and sourceLabel', async () => {
        vi.mocked(executeFileTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'c2', name: 'read_file', input: { path: 'notes/a.md' } },
          { conversationId: 'conv-1', sourceLabel: 'Task A' },
        );

        expect(executeFileTools).toHaveBeenCalledWith(
          'read_file',
          expect.objectContaining({
            _conversationId: 'conv-1',
            _sourceLabel: 'Task A',
          }),
        );
      });

      it('does NOT inject context into http tools', async () => {
        vi.mocked(executeHttpTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'c3', name: 'http_get', input: { url: 'https://x.com' } },
          { messageId: 'msg-123' },
        );

        // http tools receive raw input, not inputWithContext
        expect(executeHttpTools).toHaveBeenCalledWith('http_get', { url: 'https://x.com' });
      });
    });

    describe('write approval logic', () => {
      it('requires approval for write_file to non-note paths', async () => {
        vi.mocked(executeFileTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'w1', name: 'write_file', input: { path: 'triggers/t.yaml', content: 'data' } },
          { requireWriteApproval: true },
        );

        expect(executeFileTools).toHaveBeenCalledWith(
          'write_file',
          expect.objectContaining({ _requireApproval: true }),
        );
      });

      it('does NOT require approval for notes/ path', async () => {
        vi.mocked(executeFileTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'w2', name: 'write_file', input: { path: 'notes/note.md', content: 'data' } },
          { requireWriteApproval: true },
        );

        expect(executeFileTools).toHaveBeenCalledWith(
          'write_file',
          expect.not.objectContaining({ _requireApproval: true }),
        );
      });

      it('does NOT require approval for memory.md', async () => {
        vi.mocked(executeFileTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'w3', name: 'write_file', input: { path: 'memory.md', content: 'data' } },
          { requireWriteApproval: true },
        );

        expect(executeFileTools).toHaveBeenCalledWith(
          'write_file',
          expect.not.objectContaining({ _requireApproval: true }),
        );
      });

      it('does NOT require approval when requireWriteApproval is false', async () => {
        vi.mocked(executeFileTools).mockResolvedValue({
          tool_use_id: 'x',
          content: 'ok',
        });

        await registry.executeTool(
          { id: 'w4', name: 'write_file', input: { path: 'triggers/t.yaml', content: 'data' } },
          { requireWriteApproval: false },
        );

        expect(executeFileTools).toHaveBeenCalledWith(
          'write_file',
          expect.not.objectContaining({ _requireApproval: true }),
        );
      });
    });

    it('handles executor errors gracefully', async () => {
      vi.mocked(executeFileTools).mockRejectedValue(new Error('disk full'));

      const result = await registry.executeTool({
        id: 'err-1',
        name: 'read_file',
        input: { path: 'notes/a.md' },
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('disk full');
      expect(result.tool_use_id).toBe('err-1');
    });

    it('always sets tool_use_id from toolCall.id', async () => {
      vi.mocked(executeFileTools).mockResolvedValue({
        tool_use_id: 'wrong-id',
        content: 'ok',
      });

      const result = await registry.executeTool({
        id: 'correct-id',
        name: 'read_file',
        input: { path: 'notes/a.md' },
      });

      expect(result.tool_use_id).toBe('correct-id');
    });
  });

  describe('validatePath', () => {
    it('accepts relative paths', () => {
      expect(ToolRegistry.validatePath('notes/test.md')).toBe(true);
      expect(ToolRegistry.validatePath('conversations/conv.yaml')).toBe(true);
      expect(ToolRegistry.validatePath('memory.md')).toBe(true);
    });

    it('rejects paths with directory traversal', () => {
      expect(ToolRegistry.validatePath('../secrets.txt')).toBe(false);
      expect(ToolRegistry.validatePath('notes/../../etc/passwd')).toBe(false);
    });

    it('rejects absolute paths', () => {
      expect(ToolRegistry.validatePath('/etc/passwd')).toBe(false);
      expect(ToolRegistry.validatePath('/Users/test/file')).toBe(false);
    });

    it('handles backslash paths', () => {
      expect(ToolRegistry.validatePath('notes\\..\\secrets')).toBe(false);
    });
  });
});
