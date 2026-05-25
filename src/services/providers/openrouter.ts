import { OpenAICompatibleService } from './openai-compatible';

// OpenRouter unifies many vendors behind one OpenAI-compatible API.
// Model key format is `openrouter/<vendor>/<model>` — the modelId portion
// (everything after the first slash) is passed verbatim to OpenRouter's API,
// which is exactly the `<vendor>/<model>` form it expects.
const OPENROUTER_MODELS = [
  { key: 'openrouter/anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
  { key: 'openrouter/anthropic/claude-opus-4', name: 'Claude Opus 4', contextWindow: 200000 },
  { key: 'openrouter/openai/gpt-5', name: 'GPT-5', contextWindow: 200000 },
  { key: 'openrouter/openai/gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
  { key: 'openrouter/google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000 },
  { key: 'openrouter/google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000 },
  { key: 'openrouter/meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', contextWindow: 128000 },
  { key: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', contextWindow: 128000 },
  { key: 'openrouter/qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', contextWindow: 128000 },
  { key: 'openrouter/mistralai/mistral-large', name: 'Mistral Large', contextWindow: 128000 },
];

export class OpenRouterService extends OpenAICompatibleService {
  constructor() {
    super({
      providerType: 'openrouter',
      models: OPENROUTER_MODELS,
      titleModel: 'openai/gpt-4o-mini',
      errorPrefix: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/borismus/alloy',
        'X-Title': 'Alloy',
      },
    });
  }
}
