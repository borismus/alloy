import { GoogleGenerativeAI, GenerativeModel, Content } from '@google/generative-ai';
import { Message, ModelInfo } from '../../types';
import { IProviderService, ChatOptions, ChatResult } from './types';

const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini' },
  { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', provider: 'gemini' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'gemini' },
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

      const model = this.client.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
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

    const model: GenerativeModel = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction: options.systemPrompt,
    });

    const chat = model.startChat({
      history: geminiHistory,
    });

    const result = await chat.sendMessageStream(lastMessage.parts);

    let fullResponse = '';

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
    }

    return { content: fullResponse };
  }
}
