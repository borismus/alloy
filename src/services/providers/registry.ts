import { ModelInfo, ProviderType, Config, getProviderFromModel, getModelIdFromModel } from '../../types';
import { IProviderService } from './types';
import { AnthropicService } from './anthropic';
import { OpenAIService } from './openai';
import { OllamaService } from './ollama';
import { GeminiService } from './gemini';
import { GrokService } from './grok';

export class ProviderRegistry {
  private providers: Map<ProviderType, IProviderService> = new Map();
  private configDefaultModel: string | null = null;

  constructor() {
    // Register all provider services
    this.providers.set('anthropic', new AnthropicService());
    this.providers.set('openai', new OpenAIService());
    this.providers.set('ollama', new OllamaService());
    this.providers.set('gemini', new GeminiService());
    this.providers.set('grok', new GrokService());
  }

  async initializeFromConfig(config: Config): Promise<void> {
    // Store the default model from config (format: "provider/model-id")
    this.configDefaultModel = config.defaultModel || null;
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

    // Initialize Ollama if base URL is present (model discovery is async/non-blocking)
    if (config.OLLAMA_BASE_URL) {
      const ollama = this.providers.get('ollama') as OllamaService;
      ollama?.initialize(config.OLLAMA_BASE_URL);
    }

    // Initialize Gemini if key is present
    if (config.GEMINI_API_KEY) {
      const gemini = this.providers.get('gemini');
      gemini?.initialize(config.GEMINI_API_KEY);
    }

    // Initialize Grok (xAI) if key is present
    if (config.XAI_API_KEY) {
      const grok = this.providers.get('grok');
      grok?.initialize(config.XAI_API_KEY);
    }
  }

  async discoverOllamaModels(): Promise<void> {
    const ollama = this.providers.get('ollama') as OllamaService;
    if (ollama?.isInitialized()) {
      await ollama.discoverModels();
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

  // Parse "provider/model-id" format, returns [provider, modelId] or null
  private parseDefaultModel(): [ProviderType, string] | null {
    if (!this.configDefaultModel) return null;
    if (!this.configDefaultModel.includes('/')) return null;
    return [getProviderFromModel(this.configDefaultModel), getModelIdFromModel(this.configDefaultModel)];
  }

  getDefaultProvider(): ProviderType | null {
    const enabled = this.getEnabledProviderTypes();
    if (enabled.length === 0) return null;

    // First, try to use the provider from config's defaultModel
    const parsed = this.parseDefaultModel();
    if (parsed && enabled.includes(parsed[0])) {
      return parsed[0];
    }

    // Fall back: prefer anthropic, then openai, then first available
    if (enabled.includes('anthropic')) return 'anthropic';
    if (enabled.includes('openai')) return 'openai';
    return enabled[0];
  }

  getDefaultModel(): string | null {
    const defaultProvider = this.getDefaultProvider();
    if (!defaultProvider) return null;

    // First, try to use the model from config's defaultModel if provider matches
    const parsed = this.parseDefaultModel();
    if (parsed && parsed[0] === defaultProvider) {
      return parsed[1];
    }

    // Fall back to first available model for the provider
    const provider = this.providers.get(defaultProvider);
    const models = provider?.getAvailableModels() || [];
    // Return just the model ID portion (after the slash) for API calls
    return models[0] ? getModelIdFromModel(models[0].key) : null;
  }
}

export const providerRegistry = new ProviderRegistry();
