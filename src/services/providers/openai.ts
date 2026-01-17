import OpenAI from 'openai';
import { Message, ModelInfo, ToolUse } from '../../types';
import { ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';
import { openaiToolAdapter } from './tool-adapters/openai';

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

    // Convert tools to OpenAI format if provided
    const openaiTools = options.tools
      ? openaiToolAdapter.toProviderFormat(options.tools)
      : undefined;

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      stream: true,
      tools: openaiTools,
    });

    let fullResponse = '';
    const toolUseList: ToolUse[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = 'end_turn';

    // Track tool calls being built from stream
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      // Check if aborted
      if (options.signal?.aborted) {
        stream.controller.abort();
        break;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      // Handle finish reason
      if (choice.finish_reason) {
        if (choice.finish_reason === 'tool_calls') {
          stopReason = 'tool_use';
        } else if (choice.finish_reason === 'stop') {
          stopReason = 'end_turn';
        } else if (choice.finish_reason === 'length') {
          stopReason = 'max_tokens';
        }
      }

      // Handle content delta
      const content = choice.delta?.content;
      if (content) {
        fullResponse += content;
        options.onChunk?.(content);
      }

      // Handle tool call deltas
      const deltaToolCalls = choice.delta?.tool_calls;
      if (deltaToolCalls) {
        for (const toolCallDelta of deltaToolCalls) {
          const index = toolCallDelta.index;

          if (!toolCallBuilders.has(index)) {
            // New tool call starting
            toolCallBuilders.set(index, {
              id: toolCallDelta.id || '',
              name: toolCallDelta.function?.name || '',
              arguments: '',
            });

            // Notify UI about new tool use
            const toolUse: ToolUse = {
              type: toolCallDelta.function?.name || 'unknown',
              input: {},
            };
            toolUseList.push(toolUse);
            options.onToolUse?.(toolUse);
          }

          const builder = toolCallBuilders.get(index)!;

          // Accumulate ID if provided
          if (toolCallDelta.id) {
            builder.id = toolCallDelta.id;
          }

          // Accumulate function name if provided
          if (toolCallDelta.function?.name) {
            builder.name = toolCallDelta.function.name;
          }

          // Accumulate arguments
          if (toolCallDelta.function?.arguments) {
            builder.arguments += toolCallDelta.function.arguments;
          }
        }
      }
    }

    // Finalize tool calls
    for (const [index, builder] of toolCallBuilders) {
      try {
        const input = builder.arguments ? JSON.parse(builder.arguments) : {};
        toolCalls.push({
          id: builder.id,
          name: builder.name,
          input,
        });

        // Update the tool use entry with parsed input
        if (toolUseList[index]) {
          toolUseList[index].input = input;
        }
      } catch (e) {
        console.error('Failed to parse tool arguments:', e);
      }
    }

    return {
      content: fullResponse,
      toolUse: toolUseList.length > 0 ? toolUseList : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
    };
  }

  // Send a message with tool results (for tool execution loop)
  // toolHistory contains all previous tool rounds, allowing multi-turn tool use
  async sendMessageWithToolResults(
    messages: Message[],
    toolHistory: ToolRound[],
    options: ChatOptions
  ): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. Please provide an API key.');
    }

    // Build the messages including all tool rounds
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options.systemPrompt) {
      openaiMessages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    // Convert existing messages
    for (const msg of messages.filter((m) => m.role !== 'log')) {
      openaiMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Add all tool rounds to the message history
    for (const round of toolHistory) {
      // Add assistant message with tool_calls
      openaiMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: round.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      });

      // Add tool results
      const formattedResults = openaiToolAdapter.formatToolResults(round.toolResults);
      openaiMessages.push(...formattedResults);
    }

    // Convert tools to OpenAI format
    const openaiTools = options.tools
      ? openaiToolAdapter.toProviderFormat(options.tools)
      : undefined;

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      stream: true,
      tools: openaiTools,
    });

    let fullResponse = '';
    const toolUseList: ToolUse[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = 'end_turn';
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        stream.controller.abort();
        break;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        if (choice.finish_reason === 'tool_calls') {
          stopReason = 'tool_use';
        } else if (choice.finish_reason === 'stop') {
          stopReason = 'end_turn';
        } else if (choice.finish_reason === 'length') {
          stopReason = 'max_tokens';
        }
      }

      const content = choice.delta?.content;
      if (content) {
        fullResponse += content;
        options.onChunk?.(content);
      }

      const deltaToolCalls = choice.delta?.tool_calls;
      if (deltaToolCalls) {
        for (const toolCallDelta of deltaToolCalls) {
          const index = toolCallDelta.index;

          if (!toolCallBuilders.has(index)) {
            toolCallBuilders.set(index, {
              id: toolCallDelta.id || '',
              name: toolCallDelta.function?.name || '',
              arguments: '',
            });

            const toolUse: ToolUse = {
              type: toolCallDelta.function?.name || 'unknown',
              input: {},
            };
            toolUseList.push(toolUse);
            options.onToolUse?.(toolUse);
          }

          const builder = toolCallBuilders.get(index)!;
          if (toolCallDelta.id) builder.id = toolCallDelta.id;
          if (toolCallDelta.function?.name) builder.name = toolCallDelta.function.name;
          if (toolCallDelta.function?.arguments) builder.arguments += toolCallDelta.function.arguments;
        }
      }
    }

    // Finalize tool calls
    for (const [index, builder] of toolCallBuilders) {
      try {
        const input = builder.arguments ? JSON.parse(builder.arguments) : {};
        toolCalls.push({ id: builder.id, name: builder.name, input });
        if (toolUseList[index]) {
          toolUseList[index].input = input;
        }
      } catch (e) {
        console.error('Failed to parse tool arguments:', e);
      }
    }

    return {
      content: fullResponse,
      toolUse: toolUseList.length > 0 ? toolUseList : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
    };
  }
}
