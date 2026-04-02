import { OpenAICompatibleService } from './openai-compatible';

const OPENAI_MODELS = [
  { key: 'openai/gpt-5.4', name: 'GPT-5.4', contextWindow: 128000 },
  { key: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 128000 },
  { key: 'openai/gpt-5.4-nano', name: 'GPT-5.4 Nano', contextWindow: 128000 },
];

export class OpenAIService extends OpenAICompatibleService {
  constructor() {
    super({
      providerType: 'openai',
      models: OPENAI_MODELS,
      titleModel: 'gpt-5.4-nano',
      errorPrefix: 'OpenAI',
    });
  }
}
