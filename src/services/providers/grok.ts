import { OpenAICompatibleService } from './openai-compatible';

const GROK_MODELS = [
  { key: 'grok/grok-4.20-0309', name: 'Grok 4.20', contextWindow: 131072 },
  { key: 'grok/grok-4-1-fast', name: 'Grok 4.1 Fast', contextWindow: 131072 },
];

export class GrokService extends OpenAICompatibleService {
  constructor() {
    super({
      providerType: 'grok',
      models: GROK_MODELS,
      titleModel: 'grok-4-1-fast-non-reasoning',
      errorPrefix: 'Grok',
      baseURL: 'https://api.x.ai/v1',
    });
  }
}
