import { GoogleGenerativeAI, GenerativeModel, Content, Part, FunctionCall as GeminiFunctionCall, GenerateContentStreamResult } from '@google/generative-ai';
import { Message, ModelInfo, ToolUse } from '../../types';
import { ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';
import { geminiToolAdapter } from './tool-adapters/gemini';

const GEMINI_MODELS: ModelInfo[] = [
  { key: 'gemini/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', contextWindow: 1000000 },
  { key: 'gemini/gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000 },
  { key: 'gemini/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextWindow: 1000000 },
];

// Ensure we have a valid MIME type (Gemini requires full type like 'image/png')
function normalizeImageMimeType(mimeType: string | undefined, filePath: string): string {
  if (mimeType && mimeType.includes('/')) {
    return mimeType;
  }
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * Clean Gemini history: strip leading model messages and merge consecutive same-role messages.
 * Gemini requires first content to be 'user' and roles to alternate.
 */
function cleanGeminiHistory(history: Content[]): Content[] {
  const cleaned: Content[] = [];
  for (const entry of history) {
    if (cleaned.length === 0 && entry.role === 'model') {
      continue;
    }
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === entry.role) {
      prev.parts = prev.parts.concat(entry.parts);
    } else {
      cleaned.push({ ...entry });
    }
  }
  return cleaned;
}

/**
 * Convert messages to Gemini Content format with image support.
 */
async function messagesToGeminiHistory(messages: Message[], imageLoader?: ChatOptions['imageLoader']): Promise<Content[]> {
  const filtered = messages.filter((msg) => msg.role !== 'log');
  const history: Content[] = [];

  for (const msg of filtered) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: Part[] = [];

    const hasImages = msg.attachments?.some(a => a.type === 'image') && imageLoader;

    if (hasImages) {
      for (const attachment of msg.attachments || []) {
        if (attachment.type === 'image' && imageLoader) {
          const { data, mimeType } = await imageLoader(attachment.path);
          parts.push({
            inlineData: {
              mimeType: normalizeImageMimeType(mimeType, attachment.path),
              data,
            },
          });
        }
      }
    }

    if (msg.content) {
      parts.push({ text: msg.content });
    }

    if (parts.length > 0) {
      history.push({ role, parts });
    }
  }

  return history;
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
      const text = result.response.text();

      if (text) {
        return text.trim().slice(0, 100);
      }
    } catch (error) {
      console.error('Failed to generate title:', error);
    }

    return userMessage.slice(0, 50);
  }

  /**
   * Process a Gemini streaming response into a ChatResult.
   * Shared by both sendMessage and sendMessageWithToolResults.
   */
  private async processStream(
    result: GenerateContentStreamResult,
    options: ChatOptions,
  ): Promise<ChatResult> {
    let fullResponse = '';
    const toolUseList: ToolUse[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = 'end_turn';
    const functionCallsWithSignatures: { call: GeminiFunctionCall; signature?: string }[] = [];
    let lastFinishReason: string | undefined;
    let blockReason: string | undefined;

    for await (const chunk of result.stream) {
      if (options.signal?.aborted) {
        break;
      }

      if ((chunk as any).promptFeedback?.blockReason) {
        blockReason = (chunk as any).promptFeedback.blockReason;
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
            lastFinishReason = candidate.finishReason as string;
            if (candidate.finishReason === 'STOP') {
              stopReason = 'end_turn';
            } else if (candidate.finishReason === 'MAX_TOKENS') {
              stopReason = 'max_tokens';
            }
          }

          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('functionCall' in part && part.functionCall) {
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

    if (functionCallsWithSignatures.length > 0) {
      stopReason = 'tool_use';

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

    // Detect blocked responses
    if (!options.signal?.aborted && fullResponse === '' && functionCallsWithSignatures.length === 0) {
      if (blockReason) {
        throw new Error(`Response blocked by Gemini (${blockReason}). Try rephrasing your message.`);
      }
      if (lastFinishReason && lastFinishReason !== 'STOP') {
        throw new Error(`Response blocked by Gemini (${lastFinishReason}). Try rephrasing your message.`);
      }
    }

    // Capture usage metadata (with timeout to avoid hanging)
    let inputTokens = 0;
    let outputTokens = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (!options.signal?.aborted) {
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('timeout')), 5000);
        });
        const response = await Promise.race([result.response, timeout]);
        inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
        outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      } catch {
        // Usage metadata not available
      } finally {
        clearTimeout(timeoutId);
      }
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

  async sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('Gemini client not initialized. Please provide an API key.');
    }

    const geminiHistory = await messagesToGeminiHistory(messages, options.imageLoader);

    // Get the last user message to send
    const lastMessage = geminiHistory.pop();
    if (!lastMessage || lastMessage.role !== 'user') {
      throw new Error('Last message must be from user');
    }

    const cleanedHistory = cleanGeminiHistory(geminiHistory);

    const geminiTools = options.tools
      ? [{ functionDeclarations: geminiToolAdapter.toProviderFormat(options.tools) }]
      : undefined;

    const model: GenerativeModel = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction: options.systemPrompt,
      tools: geminiTools,
    });

    const chat = model.startChat({ history: cleanedHistory });
    const result = await chat.sendMessageStream(lastMessage.parts);

    return this.processStream(result, options);
  }

  async sendMessageWithToolResults(
    messages: Message[],
    toolHistory: ToolRound[],
    options: ChatOptions
  ): Promise<ChatResult> {
    if (!this.client) {
      throw new Error('Gemini client not initialized. Please provide an API key.');
    }

    const geminiHistory = await messagesToGeminiHistory(messages, options.imageLoader);

    // Add all tool rounds to the history (except the last one which we'll send as the message)
    for (let i = 0; i < toolHistory.length - 1; i++) {
      const round = toolHistory[i];
      const modelParts: (Part & { thoughtSignature?: string })[] = [];
      if (round.textContent) {
        modelParts.push({ text: round.textContent });
      }
      for (const tc of round.toolCalls) {
        const part: Part & { thoughtSignature?: string } = {
          functionCall: { name: tc.name, args: tc.input },
        };
        if (tc.thoughtSignature) {
          part.thoughtSignature = tc.thoughtSignature;
        }
        modelParts.push(part);
      }
      geminiHistory.push({ role: 'model', parts: modelParts as Part[] });

      geminiHistory.push({
        role: 'function',
        parts: round.toolResults.map((r) => {
          const toolCall = round.toolCalls.find((tc) => tc.id === r.tool_use_id);
          return {
            functionResponse: {
              name: toolCall?.name || 'unknown',
              response: { content: r.content },
            },
          };
        }),
      });
    }

    // Add the last round's model function calls to history
    const lastRound = toolHistory[toolHistory.length - 1];
    if (lastRound.toolCalls.length > 0) {
      const lastRoundParts: (Part & { thoughtSignature?: string })[] = [];
      if (lastRound.textContent) {
        lastRoundParts.push({ text: lastRound.textContent });
      }
      for (const tc of lastRound.toolCalls) {
        const part: Part & { thoughtSignature?: string } = {
          functionCall: { name: tc.name, args: tc.input },
        };
        if (tc.thoughtSignature) {
          part.thoughtSignature = tc.thoughtSignature;
        }
        lastRoundParts.push(part);
      }
      geminiHistory.push({ role: 'model', parts: lastRoundParts as Part[] });
    }

    // Build function responses to send as the message
    const functionResponseParts: Part[] = lastRound.toolResults.map((r) => {
      const toolCall = lastRound.toolCalls.find((tc) => tc.id === r.tool_use_id);
      return {
        functionResponse: {
          name: toolCall?.name || 'unknown',
          response: { content: r.content },
        },
      };
    });

    const cleanedHistory = cleanGeminiHistory(geminiHistory);

    const geminiTools = options.tools
      ? [{ functionDeclarations: geminiToolAdapter.toProviderFormat(options.tools) }]
      : undefined;

    const model: GenerativeModel = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction: options.systemPrompt,
      tools: geminiTools,
    });

    const chat = model.startChat({ history: cleanedHistory });
    const result = await chat.sendMessageStream(functionResponseParts);

    return this.processStream(result, options);
  }
}
