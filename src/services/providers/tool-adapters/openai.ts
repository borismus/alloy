import OpenAI from 'openai';
import { ToolDefinition, ToolCall, ToolResult } from '../../../types/tools';
import { ToolAdapter } from './types';

export class OpenAIToolAdapter implements ToolAdapter {
  toProviderFormat(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  parseToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined
  ): ToolCall[] {
    if (!toolCalls) return [];

    return toolCalls
      .filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: 'function' } =>
        call.type === 'function'
      )
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || '{}'),
      }));
  }

  formatToolResults(
    results: ToolResult[]
  ): OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] {
    return results.map((result) => ({
      role: 'tool' as const,
      tool_call_id: result.tool_use_id,
      content: result.content,
    }));
  }
}

export const openaiToolAdapter = new OpenAIToolAdapter();
