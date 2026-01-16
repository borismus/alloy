import { FunctionDeclaration, FunctionCall as GeminiFunctionCall, SchemaType, Schema } from '@google/generative-ai';
import { ToolDefinition, ToolCall, ToolResult } from '../../../types/tools';
import { ToolAdapter } from './types';

// Helper to convert JSON Schema property to Gemini Schema
function toGeminiSchema(jsonType: string, description: string): Schema {
  const base = { description };

  switch (jsonType) {
    case 'string':
      return { ...base, type: SchemaType.STRING } as Schema;
    case 'number':
      return { ...base, type: SchemaType.NUMBER } as Schema;
    case 'integer':
      return { ...base, type: SchemaType.INTEGER } as Schema;
    case 'boolean':
      return { ...base, type: SchemaType.BOOLEAN } as Schema;
    default:
      return { ...base, type: SchemaType.STRING } as Schema;
  }
}

export class GeminiToolAdapter implements ToolAdapter {
  toProviderFormat(tools: ToolDefinition[]): FunctionDeclaration[] {
    return tools.map((tool) => {
      // Convert properties to Gemini format
      const properties: Record<string, Schema> = {};

      for (const [key, value] of Object.entries(tool.input_schema.properties)) {
        properties[key] = toGeminiSchema(value.type, value.description);
      }

      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties,
          required: tool.input_schema.required,
        },
      };
    });
  }

  parseToolCalls(functionCalls: GeminiFunctionCall[] | undefined): ToolCall[] {
    if (!functionCalls) return [];

    return functionCalls.map((call, index) => ({
      // Gemini doesn't provide IDs, so we generate one
      id: `gemini-call-${Date.now()}-${index}`,
      name: call.name,
      input: (call.args || {}) as Record<string, unknown>,
    }));
  }

  formatToolResults(
    results: ToolResult[]
  ): { functionResponse: { name: string; response: { content: string } } }[] {
    return results.map((result) => ({
      functionResponse: {
        // Extract tool name from the ID we created (or use a placeholder)
        name: result.tool_use_id.split('-')[0] || 'tool',
        response: {
          content: result.content,
        },
      },
    }));
  }
}

export const geminiToolAdapter = new GeminiToolAdapter();
