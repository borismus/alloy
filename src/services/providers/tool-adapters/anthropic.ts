import Anthropic from '@anthropic-ai/sdk';
import { ToolDefinition, ToolCall, ToolResult } from '../../../types/tools';
import { ToolAdapter } from './types';

export class AnthropicToolAdapter implements ToolAdapter {
  toProviderFormat(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    }));
  }

  parseToolCalls(contentBlocks: Anthropic.ContentBlock[]): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return toolCalls;
  }

  formatToolResults(results: ToolResult[]): Anthropic.ToolResultBlockParam[] {
    return results.map((result) => ({
      type: 'tool_result' as const,
      tool_use_id: result.tool_use_id,
      content: result.content,
      is_error: result.is_error,
    }));
  }

  // Parse streaming tool use blocks
  parseStreamingToolUse(chunk: unknown): { id: string; name: string } | null {
    const typedChunk = chunk as { type: string; content_block?: { type: string; id?: string; name?: string } };

    if (typedChunk.type === 'content_block_start' && typedChunk.content_block?.type === 'tool_use') {
      return {
        id: typedChunk.content_block.id || '',
        name: typedChunk.content_block.name || '',
      };
    }
    return null;
  }
}

export const anthropicToolAdapter = new AnthropicToolAdapter();
