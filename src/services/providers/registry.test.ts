import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures these exist before vi.mock factories run
const { mockAnthropic, mockOpenAI, mockOllama, mockGemini, mockGrok } = vi.hoisted(() => {
  const createMockProvider = (type: string) => ({
    providerType: type,
    initialize: vi.fn(),
    isInitialized: vi.fn(() => false),
    sendMessage: vi.fn(),
    generateTitle: vi.fn(),
    getAvailableModels: vi.fn(() => [] as any[]),
  });

  return {
    mockAnthropic: createMockProvider('anthropic'),
    mockOpenAI: createMockProvider('openai'),
    mockOllama: { ...createMockProvider('ollama'), discoverModels: vi.fn() },
    mockGemini: createMockProvider('gemini'),
    mockGrok: createMockProvider('grok'),
  };
});

vi.mock('./anthropic', () => ({
  AnthropicService: function() { return mockAnthropic; },
}));
vi.mock('./openai', () => ({
  OpenAIService: function() { return mockOpenAI; },
}));
vi.mock('./ollama', () => ({
  OllamaService: function() { return mockOllama; },
}));
vi.mock('./gemini', () => ({
  GeminiService: function() { return mockGemini; },
}));
vi.mock('./grok', () => ({
  GrokService: function() { return mockGrok; },
}));

import { ProviderRegistry } from './registry';
import type { Config } from '../../types';

// Shorthand: partial config with defaults
function config(overrides: Partial<Config> = {}): Config {
  return { defaultModel: 'anthropic/claude-sonnet-4-6', ...overrides };
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset initialization state
    for (const mock of [mockAnthropic, mockOpenAI, mockOllama, mockGemini, mockGrok]) {
      mock.isInitialized.mockReturnValue(false);
      mock.getAvailableModels.mockReturnValue([]);
    }
    registry = new ProviderRegistry();
  });

  describe('constructor', () => {
    it('registers all 5 providers', () => {
      expect(registry.getProvider('anthropic')).toBe(mockAnthropic);
      expect(registry.getProvider('openai')).toBe(mockOpenAI);
      expect(registry.getProvider('ollama')).toBe(mockOllama);
      expect(registry.getProvider('gemini')).toBe(mockGemini);
      expect(registry.getProvider('grok')).toBe(mockGrok);
    });
  });

  describe('getProvider', () => {
    it('returns undefined for unknown provider', () => {
      expect(registry.getProvider('nonexistent' as any)).toBeUndefined();
    });
  });

  describe('initializeFromConfig', () => {
    it('initializes only providers with matching keys', async () => {
      await registry.initializeFromConfig({
        ANTHROPIC_API_KEY: 'sk-ant-test',
        OPENAI_API_KEY: 'sk-openai-test',
        defaultModel: 'anthropic/claude-sonnet-4-6',
      });

      expect(mockAnthropic.initialize).toHaveBeenCalledWith('sk-ant-test');
      expect(mockOpenAI.initialize).toHaveBeenCalledWith('sk-openai-test');
      expect(mockGemini.initialize).not.toHaveBeenCalled();
      expect(mockGrok.initialize).not.toHaveBeenCalled();
      expect(mockOllama.initialize).not.toHaveBeenCalled();
    });

    it('initializes Gemini with GEMINI_API_KEY', async () => {
      await registry.initializeFromConfig(config({ GEMINI_API_KEY: 'gem-key' }));
      expect(mockGemini.initialize).toHaveBeenCalledWith('gem-key');
    });

    it('initializes Grok with XAI_API_KEY', async () => {
      await registry.initializeFromConfig(config({ XAI_API_KEY: 'xai-key' }));
      expect(mockGrok.initialize).toHaveBeenCalledWith('xai-key');
    });

    it('initializes Ollama with OLLAMA_BASE_URL', async () => {
      await registry.initializeFromConfig(config({ OLLAMA_BASE_URL: 'http://localhost:11434' }));
      expect(mockOllama.initialize).toHaveBeenCalledWith('http://localhost:11434');
    });

    it('does not initialize any provider when config is empty', async () => {
      await registry.initializeFromConfig(config());
      for (const mock of [mockAnthropic, mockOpenAI, mockOllama, mockGemini, mockGrok]) {
        expect(mock.initialize).not.toHaveBeenCalled();
      }
    });
  });

  describe('getEnabledProviders', () => {
    it('returns only initialized providers', async () => {
      mockAnthropic.isInitialized.mockReturnValue(true);
      mockOpenAI.isInitialized.mockReturnValue(true);

      const enabled = registry.getEnabledProviders();
      expect(enabled).toHaveLength(2);
      expect(enabled).toContain(mockAnthropic);
      expect(enabled).toContain(mockOpenAI);
    });

    it('returns empty array when no providers initialized', () => {
      expect(registry.getEnabledProviders()).toEqual([]);
    });
  });

  describe('getEnabledProviderTypes', () => {
    it('returns types of initialized providers', () => {
      mockGemini.isInitialized.mockReturnValue(true);
      expect(registry.getEnabledProviderTypes()).toEqual(['gemini']);
    });
  });

  describe('getAllAvailableModels', () => {
    it('aggregates models from enabled providers only', () => {
      mockAnthropic.isInitialized.mockReturnValue(true);
      mockAnthropic.getAvailableModels.mockReturnValue([
        { key: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet' },
      ]);
      mockOpenAI.isInitialized.mockReturnValue(false);
      mockOpenAI.getAvailableModels.mockReturnValue([
        { key: 'openai/gpt-4', name: 'GPT-4' },
      ]);

      const models = registry.getAllAvailableModels();
      expect(models).toHaveLength(1);
      expect(models[0].key).toBe('anthropic/claude-sonnet-4-6');
    });

    it('returns empty when no providers enabled', () => {
      expect(registry.getAllAvailableModels()).toEqual([]);
    });
  });

  describe('getModelsGroupedByProvider', () => {
    it('groups models by provider type', () => {
      mockAnthropic.isInitialized.mockReturnValue(true);
      mockAnthropic.getAvailableModels.mockReturnValue([
        { key: 'anthropic/claude-sonnet-4-6', name: 'Sonnet' },
      ]);
      mockGemini.isInitialized.mockReturnValue(true);
      mockGemini.getAvailableModels.mockReturnValue([
        { key: 'gemini/gemini-pro', name: 'Gemini Pro' },
      ]);

      const grouped = registry.getModelsGroupedByProvider();
      expect(grouped.size).toBe(2);
      expect(grouped.get('anthropic')).toHaveLength(1);
      expect(grouped.get('gemini')).toHaveLength(1);
      expect(grouped.has('openai')).toBe(false);
    });
  });

  describe('hasAnyProvider', () => {
    it('returns false when no providers initialized', () => {
      expect(registry.hasAnyProvider()).toBe(false);
    });

    it('returns true when at least one provider initialized', () => {
      mockGrok.isInitialized.mockReturnValue(true);
      expect(registry.hasAnyProvider()).toBe(true);
    });
  });

  describe('getDefaultProvider', () => {
    it('returns null when no providers enabled', () => {
      expect(registry.getDefaultProvider()).toBeNull();
    });

    it('uses provider from config defaultModel when available', async () => {
      await registry.initializeFromConfig({
        GEMINI_API_KEY: 'key',
        ANTHROPIC_API_KEY: 'key',
        defaultModel: 'gemini/gemini-pro',
      });
      mockGemini.isInitialized.mockReturnValue(true);
      mockAnthropic.isInitialized.mockReturnValue(true);

      expect(registry.getDefaultProvider()).toBe('gemini');
    });

    it('falls back to anthropic when no defaultModel configured', async () => {
      await registry.initializeFromConfig(config({
        ANTHROPIC_API_KEY: 'key',
        OPENAI_API_KEY: 'key',
      }));
      mockAnthropic.isInitialized.mockReturnValue(true);
      mockOpenAI.isInitialized.mockReturnValue(true);

      expect(registry.getDefaultProvider()).toBe('anthropic');
    });

    it('falls back to openai when anthropic not available', async () => {
      await registry.initializeFromConfig(config({ OPENAI_API_KEY: 'key' }));
      mockOpenAI.isInitialized.mockReturnValue(true);

      expect(registry.getDefaultProvider()).toBe('openai');
    });

    it('falls back to first available when neither anthropic nor openai', async () => {
      await registry.initializeFromConfig(config({ GEMINI_API_KEY: 'key' }));
      mockGemini.isInitialized.mockReturnValue(true);

      expect(registry.getDefaultProvider()).toBe('gemini');
    });

    it('ignores defaultModel if its provider is not enabled', async () => {
      await registry.initializeFromConfig({
        ANTHROPIC_API_KEY: 'key',
        defaultModel: 'gemini/gemini-pro',
      });
      mockAnthropic.isInitialized.mockReturnValue(true);
      // gemini NOT initialized

      expect(registry.getDefaultProvider()).toBe('anthropic');
    });
  });

  describe('getDefaultModel', () => {
    it('returns null when no providers enabled', () => {
      expect(registry.getDefaultModel()).toBeNull();
    });

    it('returns model from config defaultModel when provider matches', async () => {
      await registry.initializeFromConfig({
        ANTHROPIC_API_KEY: 'key',
        defaultModel: 'anthropic/claude-opus-4-6',
      });
      mockAnthropic.isInitialized.mockReturnValue(true);

      expect(registry.getDefaultModel()).toBe('claude-opus-4-6');
    });

    it('falls back to first model from default provider', async () => {
      await registry.initializeFromConfig(config({ ANTHROPIC_API_KEY: 'key' }));
      mockAnthropic.isInitialized.mockReturnValue(true);
      mockAnthropic.getAvailableModels.mockReturnValue([
        { key: 'anthropic/claude-sonnet-4-6', name: 'Sonnet' },
        { key: 'anthropic/claude-opus-4-6', name: 'Opus' },
      ]);

      expect(registry.getDefaultModel()).toBe('claude-sonnet-4-6');
    });
  });

  describe('discoverOllamaModels', () => {
    it('calls discoverModels when ollama is initialized', async () => {
      mockOllama.isInitialized.mockReturnValue(true);
      mockOllama.discoverModels.mockResolvedValue(undefined);

      await registry.discoverOllamaModels();

      expect(mockOllama.discoverModels).toHaveBeenCalled();
    });

    it('does not call discoverModels when ollama is not initialized', async () => {
      mockOllama.isInitialized.mockReturnValue(false);

      await registry.discoverOllamaModels();

      expect(mockOllama.discoverModels).not.toHaveBeenCalled();
    });
  });
});
