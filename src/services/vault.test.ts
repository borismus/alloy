import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VaultService, spliceFavoritesBlock, spliceScalar } from './vault';
import * as dialog from '@tauri-apps/plugin-dialog';
import * as fs from '@tauri-apps/plugin-fs';
import * as yaml from 'js-yaml';
import { createMockConversation, createMockConfig, createMockFileSystemEntry } from '../test/mocks';

describe('VaultService', () => {
  let vaultService: VaultService;

  beforeEach(() => {
    vaultService = new VaultService();
    vi.clearAllMocks();
  });

  describe('selectVaultFolder', () => {
    it('should return selected folder path and initialize vault', async () => {
      const mockPath = '/test/vault/path';
      vi.mocked(dialog.open).mockResolvedValue(mockPath);
      vi.mocked(fs.exists).mockResolvedValue(false);
      vi.mocked(fs.mkdir).mockResolvedValue();
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      const result = await vaultService.selectVaultFolder();

      expect(result).toBe(mockPath);
      expect(dialog.open).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        title: 'Select Alloy Vault Folder',
      });
    });

    it('should return null when no folder selected', async () => {
      vi.mocked(dialog.open).mockResolvedValue(null);

      const result = await vaultService.selectVaultFolder();

      expect(result).toBeNull();
    });

    it('should handle array return from dialog', async () => {
      vi.mocked(dialog.open).mockResolvedValue(['path1', 'path2']);

      const result = await vaultService.selectVaultFolder();

      expect(result).toBeNull();
    });
  });

  describe('initializeVault', () => {
    it('should create conversations directory if it does not exist', async () => {
      const vaultPath = '/test/vault';
      vi.mocked(fs.exists).mockResolvedValue(false);
      vi.mocked(fs.mkdir).mockResolvedValue();
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      await vaultService.initializeVault(vaultPath);

      expect(fs.mkdir).toHaveBeenCalledWith('/test/vault/conversations', { recursive: true });
    });

    it('should not create directories if they already exist', async () => {
      const vaultPath = '/test/vault';
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      await vaultService.initializeVault(vaultPath);

      expect(fs.mkdir).not.toHaveBeenCalled();
    });

    it('should create default memory.md if it does not exist', async () => {
      const vaultPath = '/test/vault';
      vi.mocked(fs.exists).mockImplementation(async (p) => {
        // Only conversations directory exists
        return p === '/test/vault/conversations';
      });
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      await vaultService.initializeVault(vaultPath);

      expect(fs.writeTextFile).toHaveBeenCalledWith(
        '/test/vault/memory.md',
        expect.stringContaining('# Memory')
      );
    });

    it('should create default config.yaml if it does not exist', async () => {
      const vaultPath = '/test/vault';
      vi.mocked(fs.exists).mockImplementation(async (p) => {
        return p !== '/test/vault/config.yaml';
      });
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      await vaultService.initializeVault(vaultPath);

      const configCall = vi.mocked(fs.writeTextFile).mock.calls.find(
        call => call[0] === '/test/vault/config.yaml'
      );
      expect(configCall).toBeDefined();
      expect(configCall![1]).toContain('ANTHROPIC_API_KEY');
      expect(configCall![1]).toContain('defaultModel');
    });

    it('uses server-relative paths (not the absolute vault path) once a vault is bound', async () => {
      // Regression: passing the absolute path to /api/fs/* makes the server
      // re-root it under the vault, producing a doubled path. After
      // setVaultPath, fs ops must target the server-relative base ('/').
      // (The real path-join shim collapses leading slashes; the test mock
      // doesn't, hence the slash-insensitive matchers below.)
      vaultService.setVaultPath('/Users/me/vault');
      vi.mocked(fs.exists).mockResolvedValue(false);
      vi.mocked(fs.mkdir).mockResolvedValue();
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      await vaultService.initializeVault('/Users/me/vault');

      expect(fs.mkdir).toHaveBeenCalledWith(expect.stringMatching(/^\/+conversations$/), { recursive: true });
      expect(fs.writeTextFile).toHaveBeenCalledWith(expect.stringMatching(/^\/+memory\.md$/), expect.stringContaining('# Memory'));
      // Crucially, never the doubled absolute path.
      expect(fs.writeTextFile).not.toHaveBeenCalledWith(
        '/Users/me/vault/memory.md',
        expect.anything()
      );
    });
  });

  describe('note path resolution', () => {
    beforeEach(() => {
      vaultService.setVaultPath('/Users/me/vault');
    });

    it('readNote reads memory.md from the server-relative root, not the absolute path', async () => {
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readTextFile).mockResolvedValue('real memory');

      const content = await vaultService.readNote('memory.md');

      expect(content).toBe('real memory');
      expect(fs.readTextFile).toHaveBeenCalledWith(expect.stringMatching(/^\/+memory\.md$/));
      // Never the absolute vault path (which the server would double).
      expect(fs.readTextFile).not.toHaveBeenCalledWith('/Users/me/vault/memory.md');
    });

    it('readNote reads regular notes from /notes', async () => {
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readTextFile).mockResolvedValue('a note');

      await vaultService.readNote('hello.md');

      expect(fs.readTextFile).toHaveBeenCalledWith(expect.stringMatching(/^\/+notes\/hello\.md$/));
    });

    it('readNote returns null when the file does not exist', async () => {
      vi.mocked(fs.exists).mockResolvedValue(false);

      expect(await vaultService.readNote('missing.md')).toBeNull();
      expect(fs.readTextFile).not.toHaveBeenCalled();
    });

    it('getNoteFilePath returns the absolute path (for markSelfWrite / OS ops)', async () => {
      expect(await vaultService.getNoteFilePath('memory.md')).toBe('/Users/me/vault/memory.md');
      expect(await vaultService.getNoteFilePath('hello.md')).toBe('/Users/me/vault/notes/hello.md');
    });
  });

  describe('loadConfig', () => {
    it('should return null if vault path is not set', async () => {
      const result = await vaultService.loadConfig();
      expect(result).toBeNull();
    });

    it('should load and parse config from yaml file', async () => {
      vaultService.setVaultPath('/test/vault');
      const mockConfig = createMockConfig();
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readTextFile).mockResolvedValue(yaml.dump(mockConfig));

      const result = await vaultService.loadConfig();

      expect(result).toEqual(mockConfig);
      expect(fs.readTextFile).toHaveBeenCalledWith('//config.yaml');
    });

    it('should return null if config file does not exist', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(false);

      const result = await vaultService.loadConfig();

      expect(result).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('should do nothing if vault path is not set', async () => {
      const mockConfig = createMockConfig();

      await vaultService.saveConfig(mockConfig);

      expect(fs.writeTextFile).not.toHaveBeenCalled();
    });

    it('should save config to yaml file', async () => {
      vaultService.setVaultPath('/test/vault');
      const mockConfig = createMockConfig();
      vi.mocked(fs.writeTextFile).mockResolvedValue();

      await vaultService.saveConfig(mockConfig);

      expect(fs.writeTextFile).toHaveBeenCalledWith(
        '//config.yaml',
        yaml.dump(mockConfig)
      );
    });
  });

  describe('saveConversation', () => {
    it('should do nothing if vault path is not set', async () => {
      const mockConversation = createMockConversation();

      await vaultService.saveConversation(mockConversation);

      expect(fs.writeTextFile).not.toHaveBeenCalled();
    });

    it('should save conversation to yaml file', async () => {
      vaultService.setVaultPath('/test/vault');
      // Need to include messages so conversation is saved (empty messages are filtered)
      const mockConversation = createMockConversation({
        id: 'conv-123',
        messages: [
          { role: 'user', content: 'Hello', timestamp: '2024-01-01T10:00:00Z' },
        ],
      });
      vi.mocked(fs.writeTextFile).mockResolvedValue();
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([]); // No existing file

      await vaultService.saveConversation(mockConversation);

      // Verify yaml file was written (filename may include slug if title exists)
      const yamlCall = vi.mocked(fs.writeTextFile).mock.calls.find(
        call => (call[0] as string).includes('conv-123') && (call[0] as string).endsWith('.yaml')
      );
      expect(yamlCall).toBeDefined();

      // Verify markdown preview was also written
      const mdCall = vi.mocked(fs.writeTextFile).mock.calls.find(
        call => (call[0] as string).includes('conv-123') && (call[0] as string).endsWith('.md')
      );
      expect(mdCall).toBeDefined();
    });
  });

  describe('loadConversations', () => {
    it('should return empty array if vault path is not set', async () => {
      const result = await vaultService.loadConversations();
      expect(result).toEqual([]);
    });

    it('should return empty array if conversations directory does not exist', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(false);

      const result = await vaultService.loadConversations();

      expect(result).toEqual([]);
    });

    it('should load and parse all conversation files', async () => {
      vaultService.setVaultPath('/test/vault');
      const conv1 = createMockConversation({ id: 'conv-1', created: '2024-01-01T10:00:00Z', updated: '2024-01-01T10:00:00Z' });
      const conv2 = createMockConversation({ id: 'conv-2', created: '2024-01-02T10:00:00Z', updated: '2024-01-02T10:00:00Z' });

      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([
        createMockFileSystemEntry('conv-1.yaml'),
        createMockFileSystemEntry('conv-2.yaml'),
      ]);
      vi.mocked(fs.readTextFile)
        .mockResolvedValueOnce(yaml.dump(conv1))
        .mockResolvedValueOnce(yaml.dump(conv2));

      const result = await vaultService.loadConversations();

      expect(result).toHaveLength(2);
      // Should be sorted by updated date, newest first
      expect(result[0].id).toBe('conv-2');
      expect(result[1].id).toBe('conv-1');
    });

    it('should ignore non-yaml files', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([
        createMockFileSystemEntry('conv-1.yaml'),
        createMockFileSystemEntry('readme.txt'),
        createMockFileSystemEntry('conv-2.yaml'),
      ]);

      const conv1 = createMockConversation({ id: 'conv-1' });
      const conv2 = createMockConversation({ id: 'conv-2' });
      vi.mocked(fs.readTextFile)
        .mockResolvedValueOnce(yaml.dump(conv1))
        .mockResolvedValueOnce(yaml.dump(conv2));

      const result = await vaultService.loadConversations();

      expect(result).toHaveLength(2);
      expect(fs.readTextFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('loadConversation', () => {
    it('should return null if vault path is not set', async () => {
      const result = await vaultService.loadConversation('conv-123');
      expect(result).toBeNull();
    });

    it('should load and parse conversation file', async () => {
      vaultService.setVaultPath('/test/vault');
      const mockConversation = createMockConversation({ id: 'conv-123' });
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([
        createMockFileSystemEntry('conv-123.yaml'),
      ]);
      vi.mocked(fs.readTextFile).mockResolvedValue(yaml.dump(mockConversation));

      const result = await vaultService.loadConversation('conv-123');

      expect(result).toEqual(mockConversation);
      expect(fs.readTextFile).toHaveBeenCalledWith('//conversations/conv-123.yaml');
    });

    it('should return null if conversation file does not exist', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(false);

      const result = await vaultService.loadConversation('conv-123');

      expect(result).toBeNull();
    });
  });

  describe('getVaultPath and setVaultPath', () => {
    it('should get and set vault path', () => {
      expect(vaultService.getVaultPath()).toBeNull();

      vaultService.setVaultPath('/test/vault');
      expect(vaultService.getVaultPath()).toBe('/test/vault');
    });
  });

  describe('getConversationFilePath', () => {
    it('should return null if vault path is not set', async () => {
      const result = await vaultService.getConversationFilePath('conv-123');
      expect(result).toBeNull();
    });

    it('should return file path if conversation exists', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([
        createMockFileSystemEntry('conv-123.yaml'),
      ]);

      const result = await vaultService.getConversationFilePath('conv-123');

      expect(result).toBe('/test/vault/conversations/conv-123.yaml');
    });

    it('should return null if conversation does not exist', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(false);

      const result = await vaultService.getConversationFilePath('conv-123');

      expect(result).toBeNull();
    });
  });

  describe('generateSlug', () => {
    it('should convert title to URL-friendly slug', () => {
      expect(vaultService.generateSlug('Hello World')).toBe('hello-world');
      expect(vaultService.generateSlug('Test 123!')).toBe('test-123');
      expect(vaultService.generateSlug('Multiple   Spaces')).toBe('multiple-spaces');
      expect(vaultService.generateSlug('Special@#$Chars')).toBe('special-chars');
    });

    it('should remove leading and trailing hyphens', () => {
      expect(vaultService.generateSlug('---test---')).toBe('test');
      expect(vaultService.generateSlug('!@#test!@#')).toBe('test');
    });

    it('should limit slug to 50 characters', () => {
      const longTitle = 'a'.repeat(100);
      const slug = vaultService.generateSlug(longTitle);
      expect(slug.length).toBe(50);
    });
  });

  describe('renameConversation', () => {
    it('should return null if vault path is not set', async () => {
      const result = await vaultService.renameConversation('old-id', 'New Title');
      expect(result).toBeNull();
    });

    it('should return null if conversation does not exist', async () => {
      vaultService.setVaultPath('/test/vault');
      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([]); // No files found

      const result = await vaultService.renameConversation('conv-123', 'New Title');

      expect(result).toBeNull();
    });

    it('should rename conversation and update file', async () => {
      vaultService.setVaultPath('/test/vault');
      // ID format: YYYY-MM-DD-HHMM-hash (core ID stays the same)
      const coreId = '2024-01-01-1234-abcd';
      const oldFilename = `${coreId}-old-slug.yaml`;
      const newTitle = 'New Amazing Title';
      const oldConversation = createMockConversation({
        id: coreId,
        title: 'Old Title',
        messages: [
          { role: 'user', timestamp: '2024-01-01T10:00:00Z', content: 'Hello' },
        ],
      });

      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([
        createMockFileSystemEntry(oldFilename),
      ]);
      vi.mocked(fs.readTextFile).mockResolvedValue(yaml.dump(oldConversation));
      vi.mocked(fs.writeTextFile).mockResolvedValue();
      vi.mocked(fs.remove).mockResolvedValue();

      const result = await vaultService.renameConversation(coreId, newTitle);

      expect(result).toBeDefined();
      expect(result?.title).toBe(newTitle);
      // ID stays the same - only filename changes
      expect(result?.id).toBe(coreId);

      // Should have written new yaml file with new slug
      const yamlCall = vi.mocked(fs.writeTextFile).mock.calls.find(
        call => (call[0] as string).includes('new-amazing-title.yaml')
      );
      expect(yamlCall).toBeDefined();
    });

    it('should preserve conversation data when renaming', async () => {
      vaultService.setVaultPath('/test/vault');
      // ID format: YYYY-MM-DD-HHMM-hash (core ID)
      const coreId = '2024-01-01-1234-abcd';
      const oldConversation = createMockConversation({
        id: coreId,
        title: 'Old Title',
        messages: [
          { role: 'user', timestamp: '2024-01-01T10:00:00Z', content: 'Hello' },
          { role: 'assistant', timestamp: '2024-01-01T10:00:01Z', content: 'Hi there!' }
        ]
      });

      vi.mocked(fs.exists).mockResolvedValue(true);
      vi.mocked(fs.readDir).mockResolvedValue([
        createMockFileSystemEntry(`${coreId}-old-slug.yaml`),
      ]);
      vi.mocked(fs.readTextFile).mockResolvedValue(yaml.dump(oldConversation));
      vi.mocked(fs.writeTextFile).mockResolvedValue();
      vi.mocked(fs.remove).mockResolvedValue();

      const result = await vaultService.renameConversation(coreId, 'New Title');

      expect(result?.messages).toEqual(oldConversation.messages);
      expect(result?.created).toBe(oldConversation.created);
      expect(result?.model).toBe(oldConversation.model);
      // ID should stay the same
      expect(result?.id).toBe(coreId);
    });
  });
});

describe('spliceFavoritesBlock', () => {
  const block = 'favoriteModels:\n  - a\n  - b\n';

  it('appends a block to empty input', () => {
    expect(spliceFavoritesBlock('', block)).toBe(block);
  });

  it('prepends when no existing favoriteModels line', () => {
    const existing = 'defaultModel: x\nOLLAMA_BASE_URL: http://h\n';
    const out = spliceFavoritesBlock(existing, block);
    expect(out.startsWith(block)).toBe(true);
    expect(out).toContain('defaultModel: x');
    expect(out).toContain('OLLAMA_BASE_URL');
  });

  it('replaces an indented block-list cleanly', () => {
    const existing = `defaultModel: x
favoriteModels:
  - old1
  - old2
OLLAMA_BASE_URL: http://h
`;
    const out = spliceFavoritesBlock(existing, block);
    expect(out).not.toContain('old1');
    expect(out).not.toContain('old2');
    expect(out).toContain('  - a');
    expect(out).toContain('OLLAMA_BASE_URL');
  });

  it('replaces a non-indented block-list without orphaning items', () => {
    // This was the bug: a previous regex-only approach matched only
    // `favoriteModels:` and indented items, leaving the column-0 dashes
    // behind as syntactically-invalid orphans.
    const existing = `defaultModel: x
favoriteModels:
- old1
- old2
- old3
OLLAMA_BASE_URL: http://h
`;
    const out = spliceFavoritesBlock(existing, block);
    expect(out).not.toContain('old1');
    expect(out).not.toContain('old2');
    expect(out).not.toContain('old3');
    expect(out).toContain('OLLAMA_BASE_URL');
  });

  it('preserves comments and unrelated keys', () => {
    const existing = `# user-written comment
defaultModel: x
favoriteModels:
  - old
# another comment
OLLAMA_BASE_URL: http://h
`;
    const out = spliceFavoritesBlock(existing, block);
    expect(out).toContain('# user-written comment');
    expect(out).toContain('# another comment');
    expect(out).toContain('OLLAMA_BASE_URL');
  });
});

describe('spliceScalar', () => {
  it('replaces an existing key in place, preserving comments and other keys', () => {
    const existing = `# my config
defaultModel: x
externalEditor: obsidian
# keep me
OLLAMA_BASE_URL: http://h
`;
    const out = spliceScalar(existing, 'externalEditor', 'system');
    expect(out).toContain('externalEditor: system');
    expect(out).not.toContain('externalEditor: obsidian');
    expect(out).toContain('# my config');
    expect(out).toContain('# keep me');
    expect(out).toContain('OLLAMA_BASE_URL: http://h');
  });

  it('appends the key when absent, keeping existing content', () => {
    const existing = `defaultModel: x\n# comment\n`;
    const out = spliceScalar(existing, 'externalEditor', 'obsidian');
    expect(out).toContain('defaultModel: x');
    expect(out).toContain('# comment');
    expect(out).toMatch(/externalEditor: obsidian\n$/);
  });

  it('handles empty config', () => {
    expect(spliceScalar('', 'externalEditor', 'system')).toBe('externalEditor: system\n');
  });
});
