// Built-in tool types for PromptBox Skills system

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// Built-in tool definitions
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from allowed vault directories (notes/, skills/) or root files like memory.md. Cannot access conversations/.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within vault (e.g., "memory.md", "notes/todo.md", "skills/my-skill/SKILL.md")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in allowed vault directories (notes/, skills/) or root files like memory.md. Cannot access conversations/.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within vault (e.g., "memory.md", "notes/todo.md")' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_file',
    description: 'Append content to a file in allowed vault directories (notes/, skills/) or root files like memory.md. Cannot access conversations/.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within vault (e.g., "memory.md", "notes/todo.md")' },
        content: { type: 'string', description: 'Content to append' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'http_get',
    description: 'Fetch content from a URL. Supports secret tokens like ${{SECRET_NAME}} in the url which are resolved before the request is made.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'http_post',
    description: 'Send POST request to a URL. Supports secret tokens like ${{SECRET_NAME}} in url, body, and headers which are resolved before the request is made.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to post to' },
        body: { type: 'string', description: 'Request body (JSON string)' },
        headers: { type: 'string', description: 'Optional headers as JSON object' },
      },
      required: ['url', 'body'],
    },
  },
  {
    name: 'get_secret',
    description: 'Get a reference token for an API key or secret. Returns ${{SECRET_NAME}} which can be used in http_post headers/body and will be resolved to the actual value.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Secret name (e.g., SERPER_API_KEY)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'use_skill',
    description: 'Load and use a skill. Call this tool when you want to use one of the available skills. The skill instructions will be returned and you should follow them to complete the task.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill to use' },
      },
      required: ['name'],
    },
  },
];
