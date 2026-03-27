import OpenAI from 'openai';
import { fetch } from '@tauri-apps/plugin-http';
import { Message, ModelInfo, ProviderType, ToolUse } from '../../types';
import { ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';
import { openaiToolAdapter } from './tool-adapters/openai';

/**
 * Configuration that distinguishes OpenAI-compatible providers.
 * Subclasses provide these values; all streaming/tool logic is shared.
 */
export interface OpenAICompatibleConfig {
  providerType: ProviderType;
  models: ModelInfo[];
  titleModel: string;
  errorPrefix: string;       // e.g., "OpenAI" or "Grok"
  baseURL?: string;          // undefined = OpenAI default
}

/**
 * Base class for providers that use the OpenAI SDK (OpenAI, Grok, and any
 * future OpenAI-compatible API).
 */
export class OpenAICompatibleService implements IProviderService {
  readonly providerType: ProviderType;
  protected client: OpenAI | null = null;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.providerType = config.providerType;
  }

  initialize(apiKey: string): void {
    this.client = new OpenAI({
      apiKey,
      ...(this.config.baseURL && { baseURL: this.config.baseURL }),
      dangerouslyAllowBrowser: true,
      fetch,
    });
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): ModelInfo[] {
    return this.config.models;
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
        model: this.config.titleModel,
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
      throw new Error(`${this.config.errorPrefix} client not initialized. Please provide an API key.`);
    }

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'log') continue;

      const hasImages = msg.role === 'user' && msg.attachments?.some(a => a.type === 'image') && options.imageLoader;

      if (hasImages) {
        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

        for (const attachment of msg.attachments || []) {
          if (attachment.type === 'image' && options.imageLoader) {
            const { data, mimeType } = await options.imageLoader(attachment.path);
            content.push({
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${data}` },
            });
          }
        }

        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }

        openaiMessages.push({ role: 'user', content });
      } else {
        openaiMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    const openaiTools = options.tools
      ? openaiToolAdapter.toProviderFormat(options.tools)
      : undefined;

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      tools: openaiTools,
    });

    return this.processStream(stream, options);
  }

  async sendMessageWithToolResults(
    messages: Message[],
    toolHistory: ToolRound[],
    options: ChatOptions
  ): Promise<ChatResult> {
    if (!this.client) {
      throw new Error(`${this.config.errorPrefix} client not initialized. Please provide an API key.`);
    }

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages.filter((m) => m.role !== 'log')) {
      openaiMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    for (const round of toolHistory) {
      openaiMessages.push({
        role: 'assistant',
        content: round.textContent || null,
        tool_calls: round.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      });

      const formattedResults = openaiToolAdapter.formatToolResults(round.toolResults);
      openaiMessages.push(...formattedResults);
    }

    const openaiTools = options.tools
      ? openaiToolAdapter.toProviderFormat(options.tools)
      : undefined;

    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      tools: openaiTools,
    });

    return this.processStream(stream, options);
  }

  /**
   * Shared streaming logic for both sendMessage and sendMessageWithToolResults.
   */
  private async processStream(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & { controller: { abort: () => void } },
    options: ChatOptions
  ): Promise<ChatResult> {
    const onAbort = () => stream.controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let fullResponse = '';
    const toolUseList: ToolUse[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = 'end_turn';
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();

    let responseId: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        break;
      }

      if (chunk.id && !responseId) {
        responseId = chunk.id;
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
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

    options.signal?.removeEventListener('abort', onAbort);

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
      usage: (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens, responseId }
        : undefined,
    };
  }
}
