import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VaultService } from './vault';
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
      expect(fs.readTextFile).toHaveBeenCalledWith('/test/vault/config.yaml');
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
        '/test/vault/config.yaml',
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
      expect(fs.readTextFile).toHaveBeenCalledWith('/test/vault/conversations/conv-123.yaml');
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
