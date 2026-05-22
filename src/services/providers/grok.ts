import { OpenAICompatibleService } from './openai-compatible';

const GROK_MODELS = [
  { key: 'grok/grok-4.3', name: 'Grok 4.3', contextWindow: 1000000 },
  { key: 'grok/grok-4.20-0309', name: 'Grok 4.20', contextWindow: 1000000 },
];

export class GrokService extends OpenAICompatibleService {
  constructor() {
    super({
      providerType: 'grok',
      models: GROK_MODELS,
      titleModel: 'grok-4.3',
      errorPrefix: 'Grok',
      baseURL: 'https://api.x.ai/v1',
    });
  }
}
