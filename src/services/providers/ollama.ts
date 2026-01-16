import { Message, ModelInfo } from '../../types';
import { IProviderService, ChatOptions, ChatResult } from './types';

export class OllamaService implements IProviderService {
  readonly providerType = 'ollama' as const;
  private baseUrl: string | null = null;
  private cachedModels: ModelInfo[] = [];

  initialize(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  isInitialized(): boolean {
    return this.baseUrl !== null;
  }

  getAvailableModels(): ModelInfo[] {
    return this.cachedModels;
  }

  async generateTitle(userMessage: string, _assistantResponse: string): Promise<string> {
    // For Ollama, just use simple truncation - avoid extra API calls to local models
    const truncated = userMessage.slice(0, 50);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  }

  async discoverModels(): Promise<ModelInfo[]> {
    if (!this.baseUrl) {
      throw new Error('Ollama not initialized. Please provide a base URL.');
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      this.cachedModels = (data.models || []).map((m: { name: string }) => ({
        id: m.name,
        name: this.formatModelName(m.name),
        provider: 'ollama' as const,
      }));

      return this.cachedModels;
    } catch (error) {
      console.error('Failed to discover Ollama models:', error);
      return [];
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this.baseUrl) {
      return { success: false, error: 'Not initialized' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { success: true };
      }
      return { success: false, error: `HTTP ${response.status}` };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Connection timeout' };
      }
      return { success: false, error: 'Cannot connect to Ollama server' };
    }
  }

  async sendMessage(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    if (!this.baseUrl) {
      throw new Error('Ollama not initialized. Please provide a base URL.');
    }

    // Build messages array, filtering out log messages
    const ollamaMessages: Array<{ role: string; content: string }> = [];

    // Add system prompt if provided
    if (options.systemPrompt) {
      ollamaMessages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    // Add conversation messages
    for (const msg of messages) {
      if (msg.role === 'log') continue;
      ollamaMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: ollamaMessages,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullResponse = '';

    try {
      while (true) {
        // Check if aborted
        if (options.signal?.aborted) {
          reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.content) {
              fullResponse += chunk.message.content;
              options.onChunk?.(chunk.message.content);
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Aborted, return what we have so far
        return { content: fullResponse };
      }
      throw error;
    }

    return { content: fullResponse };
  }

  private formatModelName(name: string): string {
    // Format "llama3:8b" -> "Llama 3 (8B)"
    const [base, tag] = name.split(':');
    let formatted = base
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());

    if (tag) {
      formatted += ` (${tag.toUpperCase()})`;
    }

    return formatted;
  }
}
