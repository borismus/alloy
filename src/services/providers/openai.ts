import OpenAI from 'openai';
import { Message, ModelInfo } from '../../types';
import { IProviderService, ChatOptions, ChatResult } from './types';

const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai' },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai' },
  { id: 'o3', name: 'o3', provider: 'openai' },
  { id: 'o4-mini', name: 'o4 Mini', provider: 'openai' },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
];

export class OpenAIService implements IProviderService {
  readonly providerType = 'openai' as const;
  private client: OpenAI | null = null;

  initialize(apiKey: string): void {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): ModelInfo[] {
    return OPENAI_MODELS;
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

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        return content.trim().slice(0, 100);
      }
    } catch (error) {
      console.error('Failed to generate title:', error);
    }

    return userMessage.slice(0, 50);
  }

  async sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. Please provide an API key.');
    }

    // Filter out log messages and convert to OpenAI format
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options.systemPrompt) {
      openaiMessages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    // Add conversation messages
    for (const msg of messages) {
      if (msg.role === 'log') continue;

      // Check if message has image attachments (only user messages can have images in OpenAI)
      const hasImages = msg.role === 'user' && msg.attachments?.some(a => a.type === 'image') && options.imageLoader;

      if (hasImages) {
        // Build multimodal content array for OpenAI user message
        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

        // Add images
        for (const attachment of msg.attachments || []) {
          if (attachment.type === 'image' && options.imageLoader) {
            const base64 = await options.imageLoader(attachment.path);
            content.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${base64}`,
              },
            });
          }
        }

        // Add text content if present
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }

        openaiMessages.push({
          role: 'user',
          content,
        });
      } else {
        openaiMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      stream: true,
    });

    let fullResponse = '';

    for await (const chunk of stream) {
      // Check if aborted
      if (options.signal?.aborted) {
        stream.controller.abort();
        break;
      }

      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        options.onChunk?.(content);
      }
    }

    return { content: fullResponse };
  }
}
