import { ProviderType } from '../types';

export const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
  grok: 'Grok',
  openrouter: 'OpenRouter',
  'claude-cli': 'Claude (subscription)',
};

