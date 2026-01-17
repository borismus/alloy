import { GoogleGenerativeAI, GenerativeModel, Content, Part, FunctionCall as GeminiFunctionCall } from '@google/generative-ai';
import { Message, ModelInfo, ToolUse } from '../../types';
import { ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';
import { geminiToolAdapter } from './tool-adapters/gemini';

const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'gemini' },
];

export class GeminiService implements IProviderService {
  readonly providerType = 'gemini' as const;
  private client: GoogleGenerativeAI | null = null;

  initialize(apiKey: string): void {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): ModelInfo[] {
    return GEMINI_MODELS;
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

      const model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      if (text) {
        return text.trim().slice(0, 100);
      }
    } catch (error) {
      console.error('Failed to generate title:', error);
    }

    return userMessage.slice(0, 50);
  }

  async sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('Gemini client not initialized. Please provide an API key.');
    }

    // Filter out log messages and convert to Gemini format
    const filteredMessages = messages.filter((msg) => msg.role !== 'log');

    // Gemini uses 'user' and 'model' roles, and expects alternating messages
    const geminiHistory: Content[] = [];

    for (const msg of filteredMessages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      geminiHistory.push({
        role,
        parts: [{ text: msg.content }],
      });
    }

    // Get the last user message to send
    const lastMessage = geminiHistory.pop();
    if (!lastMessage || lastMessage.role !== 'user') {
      throw new Error('Last message must be from user');
    }

    // Convert tools to Gemini format if provided
    const geminiTools = options.tools
      ? [{ functionDeclarations: geminiToolAdapter.toProviderFormat(options.tools) }]
      : undefined;

    const model: GenerativeModel = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction: options.systemPrompt,
      tools: geminiTools,
    });

    const chat = model.startChat({
      history: geminiHistory,
    });

    const result = await chat.sendMessageStream(lastMessage.parts);

    let fullResponse = '';
    const toolUseList: ToolUse[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = 'end_turn';
    const functionCalls: GeminiFunctionCall[] = [];

    for await (const chunk of result.stream) {
      // Check if aborted
      if (options.signal?.aborted) {
        break;
      }

      const text = chunk.text();
      if (text) {
        fullResponse += text;
        options.onChunk?.(text);
      }

      // Check for function calls in candidates
      const candidates = chunk.candidates;
      if (candidates) {
        for (const candidate of candidates) {
          // Check finish reason
          if (candidate.finishReason) {
            if (candidate.finishReason === 'STOP') {
              stopReason = 'end_turn';
            } else if (candidate.finishReason === 'MAX_TOKENS') {
              stopReason = 'max_tokens';
            }
          }

          // Extract function calls from content parts
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('functionCall' in part && part.functionCall) {
                functionCalls.push(part.functionCall);

                // Notify UI immediately
                const toolUse: ToolUse = {
                  type: part.functionCall.name,
                  input: (part.functionCall.args || {}) as Record<string, unknown>,
                };
                toolUseList.push(toolUse);
                options.onToolUse?.(toolUse);
              }
            }
          }
        }
      }
    }

    // If we have function calls, set stop reason to tool_use
    if (functionCalls.length > 0) {
      stopReason = 'tool_use';

      // Parse function calls into our format
      const parsedCalls = geminiToolAdapter.parseToolCalls(functionCalls);
      toolCalls.push(...parsedCalls);
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
      throw new Error('Gemini client not initialized. Please provide an API key.');
    }

    // Filter out log messages and convert to Gemini format
    const filteredMessages = messages.filter((msg) => msg.role !== 'log');

    const geminiHistory: Content[] = [];

    for (const msg of filteredMessages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      geminiHistory.push({
        role,
        parts: [{ text: msg.content }],
      });
    }

    // Add all tool rounds to the history (except the last one which we'll send as the message)
    for (let i = 0; i < toolHistory.length - 1; i++) {
      const round = toolHistory[i];
      // Add model's function calls
      geminiHistory.push({
        role: 'model',
        parts: round.toolCalls.map((tc) => ({
          functionCall: {
            name: tc.name,
            args: tc.input,
          },
        })),
      });

      // Add function responses
      geminiHistory.push({
        role: 'user',
        parts: round.toolResults.map((result) => ({
          functionResponse: {
            name: result.tool_use_id,
            response: {
              content: result.content,
            },
          },
        })),
      });
    }

    // Get the last round's function responses to send as the message
    const lastRound = toolHistory[toolHistory.length - 1];
    const functionResponseParts: Part[] = lastRound.toolResults.map((result) => ({
      functionResponse: {
        name: result.tool_use_id,
        response: {
          content: result.content,
        },
      },
    }));

    // Also need to add the model's function calls for the last round to history
    if (lastRound.toolCalls.length > 0) {
      geminiHistory.push({
        role: 'model',
        parts: lastRound.toolCalls.map((tc) => ({
          functionCall: {
            name: tc.name,
            args: tc.input,
          },
        })),
      });
    }

    // Convert tools to Gemini format
    const geminiTools = options.tools
      ? [{ functionDeclarations: geminiToolAdapter.toProviderFormat(options.tools) }]
      : undefined;

    const model: GenerativeModel = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction: options.systemPrompt,
      tools: geminiTools,
    });

    const chat = model.startChat({
      history: geminiHistory,
    });

    // Send function responses
    const result = await chat.sendMessageStream(functionResponseParts);

    let fullResponse = '';
    const toolUseList: ToolUse[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = 'end_turn';
    const functionCalls: GeminiFunctionCall[] = [];

    for await (const chunk of result.stream) {
      if (options.signal?.aborted) {
        break;
      }

      const text = chunk.text();
      if (text) {
        fullResponse += text;
        options.onChunk?.(text);
      }

      const candidates = chunk.candidates;
      if (candidates) {
        for (const candidate of candidates) {
          if (candidate.finishReason) {
            if (candidate.finishReason === 'STOP') {
              stopReason = 'end_turn';
            } else if (candidate.finishReason === 'MAX_TOKENS') {
              stopReason = 'max_tokens';
            }
          }

          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('functionCall' in part && part.functionCall) {
                functionCalls.push(part.functionCall);

                const toolUse: ToolUse = {
                  type: part.functionCall.name,
                  input: (part.functionCall.args || {}) as Record<string, unknown>,
                };
                toolUseList.push(toolUse);
                options.onToolUse?.(toolUse);
              }
            }
          }
        }
      }
    }

    if (functionCalls.length > 0) {
      stopReason = 'tool_use';
      const parsedCalls = geminiToolAdapter.parseToolCalls(functionCalls);
      toolCalls.push(...parsedCalls);
    }

    return {
      content: fullResponse,
      toolUse: toolUseList.length > 0 ? toolUseList : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
    };
  }
}
