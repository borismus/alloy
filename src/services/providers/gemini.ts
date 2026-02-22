import { GoogleGenerativeAI, GenerativeModel, Content, Part, FunctionCall as GeminiFunctionCall } from '@google/generative-ai';
import { Message, ModelInfo, ToolUse } from '../../types';
import { ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';
import { geminiToolAdapter } from './tool-adapters/gemini';

const GEMINI_MODELS: ModelInfo[] = [
  { key: 'gemini/gemini-3-pro-preview', name: 'Gemini 3 Pro' },
  { key: 'gemini/gemini-3-flash-preview', name: 'Gemini 3 Flash' },
  { key: 'gemini/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { key: 'gemini/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { key: 'gemini/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
];

// Ensure we have a valid MIME type (Gemini requires full type like 'image/png')
function normalizeImageMimeType(mimeType: string | undefined, filePath: string): string {
  if (mimeType && mimeType.includes('/')) {
    return mimeType;
  }
  // Infer from file extension
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png'; // Default fallback
}

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
      const parts: Part[] = [];

      // Check for image attachments
      const hasImages = msg.attachments?.some(a => a.type === 'image') && options.imageLoader;

      if (hasImages) {
        // Add images first
        for (const attachment of msg.attachments || []) {
          if (attachment.type === 'image' && options.imageLoader) {
            const base64 = await options.imageLoader(attachment.path);
            parts.push({
              inlineData: {
                mimeType: normalizeImageMimeType(attachment.mimeType, attachment.path),
                data: base64,
              },
            });
          }
        }
      }

      // Add text content
      if (msg.content) {
        parts.push({ text: msg.content });
      }

      // Only add if we have parts
      if (parts.length > 0) {
        geminiHistory.push({ role, parts });
      }
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
    // Store function calls with their thought signatures (Gemini 3 requirement)
    const functionCallsWithSignatures: { call: GeminiFunctionCall; signature?: string }[] = [];

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
                // Capture thought signature if present (Gemini 3 feature)
                const partWithSig = part as { functionCall: GeminiFunctionCall; thoughtSignature?: string };
                functionCallsWithSignatures.push({
                  call: part.functionCall,
                  signature: partWithSig.thoughtSignature,
                });

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
    if (functionCallsWithSignatures.length > 0) {
      stopReason = 'tool_use';

      // Parse function calls into our format, including thought signatures
      for (let i = 0; i < functionCallsWithSignatures.length; i++) {
        const { call, signature } = functionCallsWithSignatures[i];
        toolCalls.push({
          id: `gemini-call-${Date.now()}-${i}`,
          name: call.name,
          input: (call.args || {}) as Record<string, unknown>,
          thoughtSignature: signature,
        });
      }
    }

    // Capture usage metadata from the completed response
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const response = await result.response;
      inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    } catch {
      // Usage metadata not available
    }

    return {
      content: fullResponse,
      toolUse: toolUseList.length > 0 ? toolUseList : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      usage: (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens }
        : undefined,
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
      const parts: Part[] = [];

      // Check for image attachments
      const hasImages = msg.attachments?.some(a => a.type === 'image') && options.imageLoader;

      if (hasImages) {
        // Add images first
        for (const attachment of msg.attachments || []) {
          if (attachment.type === 'image' && options.imageLoader) {
            const base64 = await options.imageLoader(attachment.path);
            parts.push({
              inlineData: {
                mimeType: normalizeImageMimeType(attachment.mimeType, attachment.path),
                data: base64,
              },
            });
          }
        }
      }

      // Add text content
      if (msg.content) {
        parts.push({ text: msg.content });
      }

      // Only add if we have parts
      if (parts.length > 0) {
        geminiHistory.push({ role, parts });
      }
    }

    // Add all tool rounds to the history (except the last one which we'll send as the message)
    for (let i = 0; i < toolHistory.length - 1; i++) {
      const round = toolHistory[i];
      // Add model's function calls (and any text content)
      // Include thought signatures for Gemini 3 compatibility
      const modelParts: (Part & { thoughtSignature?: string })[] = [];
      if (round.textContent) {
        modelParts.push({ text: round.textContent });
      }
      for (const tc of round.toolCalls) {
        const part: Part & { thoughtSignature?: string } = {
          functionCall: {
            name: tc.name,
            args: tc.input,
          },
        };
        if (tc.thoughtSignature) {
          part.thoughtSignature = tc.thoughtSignature;
        }
        modelParts.push(part);
      }
      geminiHistory.push({
        role: 'model',
        parts: modelParts as Part[],
      });

      // Add function responses
      geminiHistory.push({
        role: 'function',
        parts: round.toolResults.map((result) => {
          // Find the tool call to get the actual function name
          const toolCall = round.toolCalls.find((tc) => tc.id === result.tool_use_id);
          return {
            functionResponse: {
              name: toolCall?.name || 'unknown',
              response: {
                content: result.content,
              },
            },
          };
        }),
      });
    }

    // Get the last round's function responses to send as the message
    const lastRound = toolHistory[toolHistory.length - 1];
    const functionResponseParts: Part[] = lastRound.toolResults.map((result) => {
      // Find the tool call to get the actual function name
      const toolCall = lastRound.toolCalls.find((tc) => tc.id === result.tool_use_id);
      return {
        functionResponse: {
          name: toolCall?.name || 'unknown',
          response: {
            content: result.content,
          },
        },
      };
    });

    // Also need to add the model's function calls for the last round to history (with any text content)
    // Include thought signatures for Gemini 3 compatibility
    if (lastRound.toolCalls.length > 0) {
      const lastRoundParts: (Part & { thoughtSignature?: string })[] = [];
      if (lastRound.textContent) {
        lastRoundParts.push({ text: lastRound.textContent });
      }
      for (const tc of lastRound.toolCalls) {
        const part: Part & { thoughtSignature?: string } = {
          functionCall: {
            name: tc.name,
            args: tc.input,
          },
        };
        if (tc.thoughtSignature) {
          part.thoughtSignature = tc.thoughtSignature;
        }
        lastRoundParts.push(part);
      }
      geminiHistory.push({
        role: 'model',
        parts: lastRoundParts as Part[],
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
    // Store function calls with their thought signatures (Gemini 3 requirement)
    const functionCallsWithSignatures: { call: GeminiFunctionCall; signature?: string }[] = [];

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
                // Capture thought signature if present (Gemini 3 feature)
                const partWithSig = part as { functionCall: GeminiFunctionCall; thoughtSignature?: string };
                functionCallsWithSignatures.push({
                  call: part.functionCall,
                  signature: partWithSig.thoughtSignature,
                });

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
    if (functionCallsWithSignatures.length > 0) {
      stopReason = 'tool_use';

      // Parse function calls into our format, including thought signatures
      for (let i = 0; i < functionCallsWithSignatures.length; i++) {
        const { call, signature } = functionCallsWithSignatures[i];
        toolCalls.push({
          id: `gemini-call-${Date.now()}-${i}`,
          name: call.name,
          input: (call.args || {}) as Record<string, unknown>,
          thoughtSignature: signature,
        });
      }
    }

    // Capture usage metadata from the completed response
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const response = await result.response;
      inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    } catch {
      // Usage metadata not available
    }

    return {
      content: fullResponse,
      toolUse: toolUseList.length > 0 ? toolUseList : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      usage: (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens }
        : undefined,
    };
  }
}
