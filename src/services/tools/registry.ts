import { ToolDefinition, ToolCall, ToolResult, BUILTIN_TOOLS } from '../../types/tools';
import { executeFileTools } from './builtin/files';
import { executeHttpTools } from './builtin/http';
import { executeSecretTools } from './builtin/secrets';
import { executeSkillTools } from './builtin/skills';
import { executeSearchTools } from './builtin/search';
import { executeWebSearchTools } from './builtin/websearch';

export interface ToolContext {
  messageId?: string;
  conversationId?: string;  // Conversation ID for provenance tracking
  requireWriteApproval?: boolean;  // write_file always requires approval unless this is explicitly false (after user approval)
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    // Register all built-in tools
    for (const tool of BUILTIN_TOOLS) {
      this.tools.set(tool.name, tool);
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async executeTool(toolCall: ToolCall, context?: ToolContext): Promise<ToolResult> {
    console.log(`[Tool] Executing: ${toolCall.name}`, toolCall.input);

    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      console.error(`[Tool] Unknown tool: ${toolCall.name}`);
      return {
        tool_use_id: toolCall.id,
        content: `Unknown tool: ${toolCall.name}`,
        is_error: true,
      };
    }

    try {
      // Route to appropriate executor based on tool name
      let result: ToolResult;

      // Inject context into input for tools that need it
      // write_file always requires approval unless explicitly bypassed (after user approval)
      const requireApprovalForWrite = toolCall.name === 'write_file' && context?.requireWriteApproval !== false;
      const inputWithContext = {
        ...toolCall.input,
        ...(context?.messageId && { _messageId: context.messageId }),
        ...(requireApprovalForWrite && { _requireApproval: true }),
      };

      switch (toolCall.name) {
        case 'read_file':
        case 'write_file':
        case 'list_directory':
        case 'append_to_note':
          result = await executeFileTools(toolCall.name, inputWithContext);
          break;
        case 'http_get':
        case 'http_post':
          result = await executeHttpTools(toolCall.name, toolCall.input);
          break;
        case 'get_secret':
          result = await executeSecretTools(toolCall.name, toolCall.input);
          break;
        case 'use_skill':
          result = await executeSkillTools(toolCall.name, toolCall.input);
          break;
        case 'search_directory':
          result = await executeSearchTools(toolCall.name, toolCall.input);
          break;
        case 'web_search':
          result = await executeWebSearchTools(toolCall.name, toolCall.input);
          break;
        default:
          return {
            tool_use_id: toolCall.id,
            content: `No executor for tool: ${toolCall.name}`,
            is_error: true,
          };
      }

      // Ensure the tool_use_id is set correctly
      const finalResult = {
        ...result,
        tool_use_id: toolCall.id,
      };

      if (finalResult.is_error) {
        console.error(`[Tool] ${toolCall.name} failed:`, finalResult.content);
      } else {
        console.log(`[Tool] ${toolCall.name} completed successfully`);
      }

      return finalResult;
    } catch (error) {
      console.error(`[Tool] ${toolCall.name} threw error:`, error);
      return {
        tool_use_id: toolCall.id,
        content: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }

  // Validate that a path doesn't escape the vault
  static validatePath(path: string): boolean {
    // Normalize path and check for directory traversal
    const normalized = path.replace(/\\/g, '/');
    if (normalized.includes('..') || normalized.startsWith('/')) {
      return false;
    }
    return true;
  }
}

export const toolRegistry = new ToolRegistry();
