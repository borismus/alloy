// Mock utilities for testing
import { vi } from 'vitest';
import type { Conversation, Config } from '../types';

export const createMockConversation = (overrides?: Partial<Conversation>): Conversation => ({
  id: 'test-id-123',
  created: '2024-01-10T12:00:00Z',
  model: 'claude-opus-4-5-20251101',
  title: 'Test Conversation',
  messages: [],
  ...overrides,
});

export const createMockConfig = (overrides?: Partial<Config>): Config => ({
  vaultPath: '/mock/vault/path',
  anthropicApiKey: 'sk-test-key',
  defaultModel: 'claude-opus-4-5-20251101',
  ...overrides,
});

export const createMockFileSystemEntry = (name: string, isDirectory = false) => ({
  name,
  isDirectory,
  isFile: !isDirectory,
  isSymlink: false,
});

// Helper to reset all mocks
export const resetAllMocks = () => {
  vi.clearAllMocks();
  vi.resetAllMocks();
};
