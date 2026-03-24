/**
 * Server-side AI provider management.
 *
 * Reads API keys from the vault's config.yaml and initializes provider SDKs
 * directly (no Tauri plugin dependencies).
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

// Minimal message type matching src/types/index.ts
export interface ServerMessage {
  role: 'user' | 'assistant' | 'log';
  content: string;
}

export interface StreamResult {
  content: string;
  usage?: { inputTokens: number; outputTokens: number; responseId?: string };
  stopReason?: string;
}

type OnChunk = (text: string) => void;

interface StreamOptions {
  messages: ServerMessage[];
  model: string;
  systemPrompt?: string;
  onChunk: OnChunk;
  signal?: AbortSignal;
}

interface ProviderClient {
  stream(options: StreamOptions): Promise<StreamResult>;
  generateTitle(userMessage: string, assistantResponse: string): Promise<string>;
}

// --- Anthropic ---

function createAnthropicClient(apiKey: string): ProviderClient {
  const client = new Anthropic({ apiKey });

  return {
    async stream({ messages, model, systemPrompt, onChunk, signal }) {
      const anthropicMessages = messages
        .filter(m => m.role !== 'log')
        .filter(m => !(m.role === 'assistant' && !m.content))
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const stream = await client.messages.create({
            model,
            max_tokens: 8192,
            messages: anthropicMessages,
            system: systemPrompt,
            stream: true,
          });

          const onAbort = () => stream.controller.abort();
          signal?.addEventListener('abort', onAbort, { once: true });

          let fullResponse = '';
          let responseId: string | undefined;
          let inputTokens = 0;
          let outputTokens = 0;
          let stopReason = 'end_turn';

          for await (const chunk of stream) {
            if (signal?.aborted) break;

            if (chunk.type === 'message_start') {
              responseId = (chunk as Anthropic.MessageStartEvent).message.id;
              inputTokens = (chunk as Anthropic.MessageStartEvent).message.usage?.input_tokens ?? 0;
            }
            if (chunk.type === 'message_delta') {
              const delta = chunk as Anthropic.MessageDeltaEvent;
              if (delta.delta.stop_reason) stopReason = delta.delta.stop_reason;
              outputTokens = (delta as any).usage?.output_tokens ?? outputTokens;
            }
            if (chunk.type === 'content_block_delta') {
              const delta = (chunk as Anthropic.ContentBlockDeltaEvent).delta;
              if (delta.type === 'text_delta') {
                fullResponse += delta.text;
                onChunk(delta.text);
              }
            }
          }

          signal?.removeEventListener('abort', onAbort);

          return {
            content: fullResponse,
            usage: (inputTokens > 0 || outputTokens > 0)
              ? { inputTokens, outputTokens, responseId }
              : undefined,
            stopReason,
          };
        } catch (error: unknown) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const isOverloaded = lastError.message.includes('overloaded') || lastError.message.includes('Overloaded');
          if (isOverloaded && attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            continue;
          }
          throw isOverloaded
            ? new Error('Anthropic API is overloaded. Please try again in a moment.')
            : lastError;
        }
      }
      throw lastError || new Error('Failed after retries');
    },

    async generateTitle(userMessage, assistantResponse) {
      try {
        const prompt = `Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: ${userMessage.slice(0, 500)}\n\nAssistant: ${assistantResponse.slice(0, 500)}`;
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 50,
          messages: [{ role: 'user', content: prompt }],
        });
        const textBlock = response.content.find(b => b.type === 'text');
        if (textBlock && textBlock.type === 'text') return textBlock.text.trim().slice(0, 100);
      } catch (e) {
        console.error('[Providers] Failed to generate title:', e);
      }
      return userMessage.slice(0, 50);
    },
  };
}

// --- OpenAI ---

function createOpenAIClient(apiKey: string): ProviderClient {
  const client = new OpenAI({ apiKey });

  return {
    async stream({ messages, model, systemPrompt, onChunk, signal }) {
      const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

      if (systemPrompt) {
        openaiMessages.push({ role: 'system', content: systemPrompt });
      }

      for (const msg of messages) {
        if (msg.role === 'log') continue;
        openaiMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }

      const stream = await client.chat.completions.create({
        model,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      });

      const onAbort = () => stream.controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let fullResponse = '';
      let responseId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        if (chunk.id && !responseId) responseId = chunk.id;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason === 'stop') stopReason = 'end_turn';
        else if (choice.finish_reason === 'length') stopReason = 'max_tokens';

        const content = choice.delta?.content;
        if (content) {
          fullResponse += content;
          onChunk(content);
        }
      }

      signal?.removeEventListener('abort', onAbort);

      return {
        content: fullResponse,
        usage: (inputTokens > 0 || outputTokens > 0)
          ? { inputTokens, outputTokens, responseId }
          : undefined,
        stopReason,
      };
    },

    async generateTitle(userMessage, assistantResponse) {
      try {
        const prompt = `Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: ${userMessage.slice(0, 500)}\n\nAssistant: ${assistantResponse.slice(0, 500)}`;
        const response = await client.chat.completions.create({
          model: 'gpt-5.4-nano',
          max_tokens: 50,
          messages: [{ role: 'user', content: prompt }],
        });
        const content = response.choices[0]?.message?.content;
        if (content) return content.trim().slice(0, 100);
      } catch (e) {
        console.error('[Providers] Failed to generate title:', e);
      }
      return userMessage.slice(0, 50);
    },
  };
}

// --- Gemini ---

function createGeminiClient(apiKey: string): ProviderClient {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    async stream({ messages, model, systemPrompt, onChunk, signal }) {
      const filteredMessages = messages.filter(m => m.role !== 'log');

      // Gemini uses 'user' and 'model' roles
      const geminiHistory: { role: string; parts: { text: string }[] }[] = [];
      for (const msg of filteredMessages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        if (msg.content) {
          geminiHistory.push({ role, parts: [{ text: msg.content }] });
        }
      }

      // Last message is sent separately
      const lastMessage = geminiHistory.pop();
      if (!lastMessage || lastMessage.role !== 'user') {
        throw new Error('Last message must be from user');
      }

      // Clean history: strip leading model messages, merge consecutive same-role
      const cleanedHistory: { role: string; parts: { text: string }[] }[] = [];
      for (const entry of geminiHistory) {
        if (cleanedHistory.length === 0 && entry.role === 'model') continue;
        const prev = cleanedHistory[cleanedHistory.length - 1];
        if (prev && prev.role === entry.role) {
          prev.parts = prev.parts.concat(entry.parts);
        } else {
          cleanedHistory.push({ ...entry });
        }
      }

      const geminiModel = genAI.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
      });

      const chat = geminiModel.startChat({ history: cleanedHistory as any });
      const result = await chat.sendMessageStream(lastMessage.parts);

      let fullResponse = '';
      let stopReason = 'end_turn';

      for await (const chunk of result.stream) {
        if (signal?.aborted) break;
        const text = chunk.text();
        if (text) {
          fullResponse += text;
          onChunk(text);
        }

        // Check finish reason
        const candidates = chunk.candidates;
        if (candidates) {
          for (const candidate of candidates) {
            if (candidate.finishReason === 'MAX_TOKENS') {
              stopReason = 'max_tokens';
            }
          }
        }
      }

      // Try to get usage
      let inputTokens = 0;
      let outputTokens = 0;
      if (!signal?.aborted) {
        try {
          const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('timeout')), 5000);
          });
          const response = await Promise.race([result.response, timeout]);
          inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
          outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
        } catch {
          // Usage not available
        }
      }

      return {
        content: fullResponse,
        usage: (inputTokens > 0 || outputTokens > 0)
          ? { inputTokens, outputTokens }
          : undefined,
        stopReason,
      };
    },

    async generateTitle(userMessage, assistantResponse) {
      try {
        const prompt = `Generate a short, descriptive title (3-6 words) for a conversation that started with this exchange. Return ONLY the title, no quotes or punctuation.\n\nUser: ${userMessage.slice(0, 500)}\n\nAssistant: ${assistantResponse.slice(0, 500)}`;
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text) return text.trim().slice(0, 100);
      } catch (e) {
        console.error('[Providers] Failed to generate title:', e);
      }
      return userMessage.slice(0, 50);
    },
  };
}

// --- Grok (xAI) - uses OpenAI-compatible API ---

function createGrokClient(apiKey: string): ProviderClient {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
  });

  // Reuse OpenAI streaming logic with xAI base URL
  const openaiClient = createOpenAIClient(apiKey);

  return {
    async stream(options) {
      // Override the client by creating a stream directly
      const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (options.systemPrompt) {
        openaiMessages.push({ role: 'system', content: options.systemPrompt });
      }
      for (const msg of options.messages) {
        if (msg.role === 'log') continue;
        openaiMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }

      const stream = await client.chat.completions.create({
        model: options.model,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      });

      const onAbort = () => stream.controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      let fullResponse = '';
      let responseId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';

      for await (const chunk of stream) {
        if (options.signal?.aborted) break;
        if (chunk.id && !responseId) responseId = chunk.id;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason === 'stop') stopReason = 'end_turn';
        else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
        const content = choice.delta?.content;
        if (content) {
          fullResponse += content;
          options.onChunk(content);
        }
      }

      options.signal?.removeEventListener('abort', onAbort);

      return {
        content: fullResponse,
        usage: (inputTokens > 0 || outputTokens > 0)
          ? { inputTokens, outputTokens, responseId }
          : undefined,
        stopReason,
      };
    },

    async generateTitle(userMessage, assistantResponse) {
      return openaiClient.generateTitle(userMessage, assistantResponse);
    },
  };
}

// --- Provider Registry ---

const providers = new Map<string, ProviderClient>();

interface Config {
  defaultModel?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  XAI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
}

export async function initializeProviders(vaultPath: string): Promise<void> {
  const configPath = path.join(vaultPath, 'config.yaml');

  let config: Config;
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    config = yaml.load(content) as Config;
  } catch (e) {
    console.error('[Providers] Failed to read config.yaml:', e);
    return;
  }

  if (config.ANTHROPIC_API_KEY) {
    providers.set('anthropic', createAnthropicClient(config.ANTHROPIC_API_KEY));
    console.log('[Providers] Anthropic initialized');
  }
  if (config.OPENAI_API_KEY) {
    providers.set('openai', createOpenAIClient(config.OPENAI_API_KEY));
    console.log('[Providers] OpenAI initialized');
  }
  if (config.GEMINI_API_KEY) {
    providers.set('gemini', createGeminiClient(config.GEMINI_API_KEY));
    console.log('[Providers] Gemini initialized');
  }
  if (config.XAI_API_KEY) {
    providers.set('grok', createGrokClient(config.XAI_API_KEY));
    console.log('[Providers] Grok initialized');
  }
}

/**
 * Get a provider client by model string ("provider/model-id").
 * Returns [client, modelId] or throws.
 */
export function getProvider(modelString: string): [ProviderClient, string] {
  const slashIndex = modelString.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid model format: "${modelString}". Expected "provider/model-id".`);
  }
  const providerName = modelString.slice(0, slashIndex);
  const modelId = modelString.slice(slashIndex + 1);

  const client = providers.get(providerName);
  if (!client) {
    throw new Error(`Provider "${providerName}" is not configured.`);
  }

  return [client, modelId];
}
