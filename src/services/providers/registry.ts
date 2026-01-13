import { ModelInfo, ProviderType, Config } from '../../types';
import { IProviderService } from './types';
import { AnthropicService } from './anthropic';
import { OpenAIService } from './openai';
import { OllamaService } from './ollama';

export class ProviderRegistry {
  private providers: Map<ProviderType, IProviderService> = new Map();

  constructor() {
    // Register all provider services
    this.providers.set('anthropic', new AnthropicService());
    this.providers.set('openai', new OpenAIService());
    this.providers.set('ollama', new OllamaService());
  }

  async initializeFromConfig(config: Config): Promise<void> {
    // Initialize Anthropic if key is present
    if (config.ANTHROPIC_API_KEY) {
      const anthropic = this.providers.get('anthropic');
      anthropic?.initialize(config.ANTHROPIC_API_KEY);
    }

    // Initialize OpenAI if key is present
    if (config.OPENAI_API_KEY) {
      const openai = this.providers.get('openai');
      openai?.initialize(config.OPENAI_API_KEY);
    }

    // Initialize Ollama if base URL is present
    if (config.OLLAMA_BASE_URL) {
      const ollama = this.providers.get('ollama') as OllamaService;
      ollama?.initialize(config.OLLAMA_BASE_URL);
      // Discover available models
      await ollama?.discoverModels();
    }
  }

  getProvider(type: ProviderType): IProviderService | undefined {
    return this.providers.get(type);
  }

  getEnabledProviders(): IProviderService[] {
    return Array.from(this.providers.values()).filter((p) => p.isInitialized());
  }

  getEnabledProviderTypes(): ProviderType[] {
    return this.getEnabledProviders().map((p) => p.providerType);
  }

  getAllAvailableModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const provider of this.getEnabledProviders()) {
      models.push(...provider.getAvailableModels());
    }
    return models;
  }

  getModelsGroupedByProvider(): Map<ProviderType, ModelInfo[]> {
    const grouped = new Map<ProviderType, ModelInfo[]>();
    for (const provider of this.getEnabledProviders()) {
      grouped.set(provider.providerType, provider.getAvailableModels());
    }
    return grouped;
  }

  hasAnyProvider(): boolean {
    return this.getEnabledProviders().length > 0;
  }

  getDefaultProvider(): ProviderType | null {
    const enabled = this.getEnabledProviderTypes();
    if (enabled.length === 0) return null;
    // Prefer anthropic, then openai, then ollama
    if (enabled.includes('anthropic')) return 'anthropic';
    if (enabled.includes('openai')) return 'openai';
    return enabled[0];
  }

  getDefaultModel(): string | null {
    const defaultProvider = this.getDefaultProvider();
    if (!defaultProvider) return null;

    const provider = this.providers.get(defaultProvider);
    const models = provider?.getAvailableModels() || [];
    return models[0]?.id || null;
  }
}

export const providerRegistry = new ProviderRegistry();
