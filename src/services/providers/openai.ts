import { OpenAICompatibleService } from './openai-compatible';

const OPENAI_MODELS = [
  { key: 'openai/gpt-5.4', name: 'GPT-5.4' },
  { key: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { key: 'openai/gpt-5.4-nano', name: 'GPT-5.4 Nano' },
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
