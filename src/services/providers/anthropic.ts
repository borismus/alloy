import Anthropic from '@anthropic-ai/sdk';
import { Message, ModelInfo } from '../../types';
import { IProviderService, ChatOptions } from './types';

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5', provider: 'anthropic' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', provider: 'anthropic' },
  { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4', provider: 'anthropic' },
  { id: 'claude-3-7-sonnet-20250219', name: 'Sonnet 3.7', provider: 'anthropic' },
];

export class AnthropicService implements IProviderService {
  readonly providerType = 'anthropic' as const;
  private client: Anthropic | null = null;

  initialize(apiKey: string): void {
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): ModelInfo[] {
    return ANTHROPIC_MODELS;
  }

  async generateTitle(userMessage: string, assistantResponse: string): Promise<string> {
    if (!this.client) {
      return userMessage.slice(0, 50);
    }

    try {
      const prompt = [
        'Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.',
        '',
        'User: ' + userMessage.slice(0, 500),
        '',
        'Assistant: ' + assistantResponse.slice(0, 500),
      ].join('\n');

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        return textBlock.text.trim().slice(0, 100);
      }
    } catch (error) {
      console.error('Failed to generate title:', error);
    }

    return userMessage.slice(0, 50);
  }

  async sendMessage(messages: Message[], options: ChatOptions): Promise<string> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized. Please provide an API key.');
    }

    // Filter out log messages and convert to Anthropic format
    const anthropicMessages = messages
      .filter((msg) => msg.role !== 'log')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const stream = await this.client.messages.create({
          model: options.model,
          max_tokens: 8192,
          messages: anthropicMessages,
          system: options.systemPrompt,
          stream: true,
          tools: [
            {
              type: 'web_search_20250305' as any,
              name: 'web_search',
              max_uses: 5,
            } as any,
          ],
        });

        let fullResponse = '';

        for await (const chunk of stream) {
          // Check if aborted
          if (options.signal?.aborted) {
            stream.controller.abort();
            break;
          }

          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            const text = chunk.delta.text;
            fullResponse += text;
            options.onChunk?.(text);
          }
        }

        return fullResponse;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's an overload error that should be retried
        const isOverloaded =
          lastError.message.includes('overloaded') ||
          lastError.message.includes('Overloaded') ||
          (error as any)?.error?.type === 'overloaded_error';

        if (isOverloaded && attempt < maxRetries - 1) {
          // Wait before retrying (exponential backoff: 1s, 2s, 4s)
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Provide user-friendly error messages
        if (isOverloaded) {
          throw new Error('Anthropic API is overloaded. Please try again in a moment.');
        }

        throw lastError;
      }
    }

    throw lastError || new Error('Failed after retries');
  }
}
