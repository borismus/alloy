import Anthropic from '@anthropic-ai/sdk';
import { Message } from '../types';

export class ClaudeService {
  private client: Anthropic | null = null;
  private model: string = 'claude-sonnet-4-20250514';

  initialize(apiKey: string, model?: string): void {
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
    if (model) {
      this.model = model;
    }
  }

  async sendMessage(
    messages: Message[],
    systemPrompt?: string,
    onChunk?: (text: string) => void
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Claude client not initialized. Please provide an API key.');
    }

    // Convert our message format to Anthropic's format
    const anthropicMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      messages: anthropicMessages,
      system: systemPrompt,
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

    try {
      for await (const chunk of stream) {
        // Handle text content
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
          const text = chunk.delta.text;
          fullResponse += text;
          if (onChunk) {
            onChunk(text);
          }
        }
        // Ignore tool use blocks - they're handled internally by the API
        // and the final text response will be provided separately
      }
    } catch (error) {
      console.error('Streaming error:', error);
      throw error;
    }

    return fullResponse;
  }
}

export const claudeService = new ClaudeService();
