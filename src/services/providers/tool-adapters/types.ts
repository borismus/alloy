import { ToolDefinition, ToolCall, ToolResult } from '../../../types/tools';

// Interface for provider-specific tool adapters
export interface ToolAdapter {
  // Convert universal tool definitions to provider-specific format
  toProviderFormat(tools: ToolDefinition[]): unknown;

  // Parse provider's tool call response to universal format
  parseToolCalls(providerResponse: unknown): ToolCall[];

  // Format tool results for provider (to send back with next message)
  formatToolResults(results: ToolResult[]): unknown;
}
