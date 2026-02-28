import { fetch } from '@tauri-apps/plugin-http';
import { Message, ModelInfo, ToolUse } from '../../types';
import { ToolDefinition, ToolCall } from '../../types/tools';
import { IProviderService, ChatOptions, ChatResult, StopReason, ToolRound } from './types';

// Build tool instructions for system prompt injection
function buildToolInstructions(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map((tool) => {
    const params = Object.entries(tool.input_schema.properties)
      .map(([name, prop]) => `  - ${name} (${prop.type}): ${prop.description}`)
      .join('\n');
    return `**${tool.name}**: ${tool.description}\nParameters:\n${params}`;
  }).join('\n\n');

  return `
You have access to the following tools. To use a tool, respond with a JSON code block in this exact format:

\`\`\`tool_call
{
  "name": "tool_name",
  "input": {
    "param1": "value1"
  }
}
\`\`\`

Available tools:

${toolDescriptions}

When you need to use a tool, output ONLY the tool_call block and wait for the result. After receiving the result, continue your response.
If you don't need to use a tool, respond normally without any tool_call blocks.
`;
}

// Parse tool calls from response text
function parseToolCalls(text: string): { toolCalls: ToolCall[]; cleanedText: string } {
  const toolCalls: ToolCall[] = [];
  let cleanedText = text;

  // Match ```tool_call blocks
  const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;
  let match;
  let index = 0;

  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.name === 'string') {
        toolCalls.push({
          id: `ollama-call-${Date.now()}-${index}`,
          name: parsed.name,
          input: parsed.input || {},
        });
        index++;
      }
    } catch (e) {
      // Invalid JSON, skip
      console.warn('Failed to parse tool call JSON:', e);
    }

    // Remove the tool call block from the text
    cleanedText = cleanedText.replace(match[0], '').trim();
  }

  return { toolCalls, cleanedText };
}

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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      this.cachedModels = (data.models || []).map((m: { name: string }) => ({
        key: `ollama/${m.name}`,
        name: this.formatModelName(m.name),
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

    // Build system prompt with tool instructions if tools are provided
    let systemPrompt = options.systemPrompt || '';
    if (options.tools && options.tools.length > 0) {
      systemPrompt += '\n\n' + buildToolInstructions(options.tools);
    }

    // Add system prompt if provided
    if (systemPrompt) {
      ollamaMessages.push({
        role: 'system',
        content: systemPrompt,
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
    let stopReason: StopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

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
            // Capture usage and done_reason from the final chunk
            if (chunk.done) {
              inputTokens = chunk.prompt_eval_count ?? 0;
              outputTokens = chunk.eval_count ?? 0;
              if (chunk.done_reason === 'length') {
                stopReason = 'max_tokens';
              }
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Aborted, return what we have so far
        return { content: fullResponse, stopReason: 'end_turn' };
      }
      throw error;
    }

    // Parse tool calls from the response
    const { toolCalls, cleanedText } = parseToolCalls(fullResponse);

    // Build tool use list for UI
    const toolUseList: ToolUse[] = toolCalls.map((call) => ({
      type: call.name,
      input: call.input,
    }));

    // Notify UI about tool uses
    for (const toolUse of toolUseList) {
      options.onToolUse?.(toolUse);
    }

    // If we found tool calls, set stop reason
    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    }

    return {
      content: cleanedText,
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
    if (!this.baseUrl) {
      throw new Error('Ollama not initialized. Please provide a base URL.');
    }

    // Build messages array
    const ollamaMessages: Array<{ role: string; content: string }> = [];

    // Build system prompt with tool instructions
    let systemPrompt = options.systemPrompt || '';
    if (options.tools && options.tools.length > 0) {
      systemPrompt += '\n\n' + buildToolInstructions(options.tools);
    }

    if (systemPrompt) {
      ollamaMessages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    // Add conversation messages
    for (const msg of messages.filter((m) => m.role !== 'log')) {
      ollamaMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add all tool rounds as assistant/user message pairs
    for (const round of toolHistory) {
      // Add assistant message describing the tool calls (include any text content)
      const toolCallsText = round.toolCalls
        .map((tc) => `<tool_call>\n<name>${tc.name}</name>\n<arguments>${JSON.stringify(tc.input)}</arguments>\n</tool_call>`)
        .join('\n');
      const assistantContent = round.textContent
        ? `${round.textContent}\n\n${toolCallsText}`
        : toolCallsText;
      ollamaMessages.push({
        role: 'assistant',
        content: assistantContent,
      });

      // Add user message with tool results
      const toolResultsText = round.toolResults
        .map((r) => {
          const status = r.is_error ? 'Error' : 'Success';
          return `Tool result (${status}):\n${r.content}`;
        })
        .join('\n\n');
      ollamaMessages.push({
        role: 'user',
        content: `Here are the results from the tool calls:\n\n${toolResultsText}\n\nPlease continue based on these results.`,
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
    let stopReason: StopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
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
            if (chunk.done) {
              inputTokens = chunk.prompt_eval_count ?? 0;
              outputTokens = chunk.eval_count ?? 0;
              if (chunk.done_reason === 'length') {
                stopReason = 'max_tokens';
              }
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { content: fullResponse, stopReason: 'end_turn' };
      }
      throw error;
    }

    // Parse tool calls from response
    const { toolCalls, cleanedText } = parseToolCalls(fullResponse);

    const toolUseList: ToolUse[] = toolCalls.map((call) => ({
      type: call.name,
      input: call.input,
    }));

    for (const toolUse of toolUseList) {
      options.onToolUse?.(toolUse);
    }

    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    }

    return {
      content: cleanedText,
      toolUse: toolUseList.length > 0 ? toolUseList : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      usage: (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens }
        : undefined,
    };
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
