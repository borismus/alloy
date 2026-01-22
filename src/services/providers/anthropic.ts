import Anthropic from '@anthropic-ai/sdk';
import { Message, ModelInfo, ToolUse } from '../../types';
import { ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';
import { anthropicToolAdapter } from './tool-adapters/anthropic';

const ANTHROPIC_MODELS: ModelInfo[] = [
  { key: 'anthropic/claude-opus-4-5-20251101', name: 'Opus 4.5' },
  { key: 'anthropic/claude-sonnet-4-5-20250929', name: 'Sonnet 4.5' },
  { key: 'anthropic/claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
  { key: 'anthropic/claude-sonnet-4-20250514', name: 'Sonnet 4' },
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

  async sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized. Please provide an API key.');
    }

    // Filter out log messages and convert to Anthropic format
    const anthropicMessages = await Promise.all(
      messages
        .filter((msg) => msg.role !== 'log')
        .map(async (msg) => {
          // Check if message has image attachments
          const hasImages = msg.attachments?.some(a => a.type === 'image') && options.imageLoader;

          if (hasImages) {
            // Build multimodal content array
            const content: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];

            // Add images first (Anthropic prefers images before text)
            for (const attachment of msg.attachments || []) {
              if (attachment.type === 'image' && options.imageLoader) {
                const base64 = await options.imageLoader(attachment.path);
                content.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: attachment.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                    data: base64,
                  },
                });
              }
            }

            // Add text content if present
            if (msg.content) {
              content.push({ type: 'text', text: msg.content });
            }

            return {
              role: msg.role as 'user' | 'assistant',
              content,
            };
          }

          // Simple text-only message
          // Skip empty assistant messages to avoid API error
          if (msg.role === 'assistant' && !msg.content) {
            return null;
          }
          return {
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          };
        })
    );

    // Filter out null entries from skipped empty messages
    const filteredMessages = anthropicMessages.filter((msg): msg is NonNullable<typeof msg> => msg !== null) as Anthropic.MessageParam[];

    // Convert tools to Anthropic format if provided
    const anthropicTools = options.tools
      ? anthropicToolAdapter.toProviderFormat(options.tools)
      : undefined;

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const stream = await this.client.messages.create({
          model: options.model,
          max_tokens: 8192,
          messages: filteredMessages,
          system: options.systemPrompt,
          stream: true,
          tools: anthropicTools,
        });

        let fullResponse = '';
        const toolUseList: ToolUse[] = [];
        const toolCalls: ToolCall[] = [];
        let stopReason: StopReason = 'end_turn';

        // Track current tool use block for streaming
        let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

        for await (const chunk of stream) {
          // Check if aborted
          if (options.signal?.aborted) {
            stream.controller.abort();
            break;
          }

          // Handle message stop to get stop reason
          if (chunk.type === 'message_delta') {
            const messageDelta = chunk as Anthropic.MessageDeltaEvent;
            if (messageDelta.delta.stop_reason) {
              stopReason = messageDelta.delta.stop_reason as StopReason;
            }
          }

          // Detect tool use start
          if (chunk.type === 'content_block_start') {
            const block = (chunk as Anthropic.ContentBlockStartEvent).content_block;

            if (block.type === 'tool_use') {
              currentToolUse = {
                id: block.id,
                name: block.name,
                inputJson: '',
              };

              const toolUse: ToolUse = {
                type: block.name,
                input: {},
              };
              toolUseList.push(toolUse);
              options.onToolUse?.(toolUse);
            }
          }

          // Accumulate tool input JSON
          if (chunk.type === 'content_block_delta') {
            const delta = (chunk as Anthropic.ContentBlockDeltaEvent).delta;

            if (delta.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.inputJson += delta.partial_json;
            }

            if (delta.type === 'text_delta') {
              const text = delta.text;
              fullResponse += text;
              options.onChunk?.(text);
            }
          }

          // Tool use block complete
          if (chunk.type === 'content_block_stop' && currentToolUse) {
            try {
              const input = currentToolUse.inputJson
                ? JSON.parse(currentToolUse.inputJson)
                : {};

              toolCalls.push({
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
              });

              // Update the last tool use entry with parsed input
              if (toolUseList.length > 0) {
                toolUseList[toolUseList.length - 1].input = input;
              }
            } catch (e) {
              console.error('Failed to parse tool input JSON:', e);
            }
            currentToolUse = null;
          }
        }

        return {
          content: fullResponse,
          toolUse: toolUseList.length > 0 ? toolUseList : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason,
        };
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

  // Send a message with tool results (for tool execution loop)
  // toolHistory contains all previous tool rounds, allowing multi-turn tool use
  async sendMessageWithToolResults(
    messages: Message[],
    toolHistory: ToolRound[],
    options: ChatOptions
  ): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized. Please provide an API key.');
    }

    // Build the messages including all tool rounds
    const anthropicMessages: Anthropic.MessageParam[] = [];

    // Convert existing messages
    for (const msg of messages.filter((m) => m.role !== 'log')) {
      if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: msg.content,
        });
      } else if (msg.role === 'assistant') {
        // Skip empty assistant messages - they only had tool use which is handled in toolHistory
        if (!msg.content) {
          continue;
        }
        anthropicMessages.push({
          role: 'assistant',
          content: msg.content,
        });
      }
    }

    // Add all tool rounds to the message history
    for (const round of toolHistory) {
      // Add the assistant message with optional text + tool_use blocks
      const assistantContent: Anthropic.ContentBlockParam[] = [];

      // Include any text the assistant said before/alongside tool calls
      if (round.textContent) {
        assistantContent.push({
          type: 'text' as const,
          text: round.textContent,
        });
      }

      // Add tool use blocks
      for (const tc of round.toolCalls) {
        assistantContent.push({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }

      anthropicMessages.push({
        role: 'assistant',
        content: assistantContent,
      });

      // Add tool results as a user message
      anthropicMessages.push({
        role: 'user',
        content: round.toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
        })),
      });
    }

    // Convert tools to Anthropic format
    const anthropicTools = options.tools
      ? anthropicToolAdapter.toProviderFormat(options.tools)
      : undefined;

    // Retry logic for overload errors (same as sendMessage)
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
          tools: anthropicTools,
        });

        let fullResponse = '';
        const toolUseList: ToolUse[] = [];
        const toolCalls: ToolCall[] = [];
        let stopReason: StopReason = 'end_turn';
        let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            stream.controller.abort();
            break;
          }

          if (chunk.type === 'message_delta') {
            const messageDelta = chunk as Anthropic.MessageDeltaEvent;
            if (messageDelta.delta.stop_reason) {
              stopReason = messageDelta.delta.stop_reason as StopReason;
            }
          }

          if (chunk.type === 'content_block_start') {
            const block = (chunk as Anthropic.ContentBlockStartEvent).content_block;
            if (block.type === 'tool_use') {
              currentToolUse = { id: block.id, name: block.name, inputJson: '' };
              const toolUse: ToolUse = { type: block.name, input: {} };
              toolUseList.push(toolUse);
              options.onToolUse?.(toolUse);
            }
          }

          if (chunk.type === 'content_block_delta') {
            const delta = (chunk as Anthropic.ContentBlockDeltaEvent).delta;
            if (delta.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.inputJson += delta.partial_json;
            }
            if (delta.type === 'text_delta') {
              fullResponse += delta.text;
              options.onChunk?.(delta.text);
            }
          }

          if (chunk.type === 'content_block_stop' && currentToolUse) {
            try {
              const input = currentToolUse.inputJson ? JSON.parse(currentToolUse.inputJson) : {};
              toolCalls.push({ id: currentToolUse.id, name: currentToolUse.name, input });
              if (toolUseList.length > 0) {
                toolUseList[toolUseList.length - 1].input = input;
              }
            } catch (e) {
              console.error('Failed to parse tool input JSON:', e);
            }
            currentToolUse = null;
          }
        }

        return {
          content: fullResponse,
          toolUse: toolUseList.length > 0 ? toolUseList : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason,
        };
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
