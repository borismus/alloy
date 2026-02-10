// Built-in tool types for Orchestra Skills system

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
  thoughtSignature?: string;  // Gemini 3 thought signature for context preservation
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  requires_approval?: boolean;
  approval_data?: {
    path: string;
    originalContent: string;
    newContent: string;
  };
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
        path: { type: 'string', description: 'Relative path within vault. Note filenames must be human-readable with spaces, not kebab-case (e.g., "notes/Investment strategy.md", not "notes/investment-strategy.md")' },
        content: { type: 'string', description: 'Content to write' },
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
  {
    name: 'list_directory',
    description: 'List files in a vault directory. Allowed directories: notes/, skills/, conversations/, triggers/. Returns file names sorted with directories first.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path within vault (e.g., "notes", "skills", "conversations", "triggers")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_directory',
    description: 'Search for files and content within vault directories (notes/, skills/, conversations/). Returns matching file paths and content snippets.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to search (e.g., "notes", "skills", "conversations")' },
        query: { type: 'string', description: 'Search query - text to find in file names or content' },
        search_content: { type: 'string', description: 'Search file content ("true") or just names ("false"). Default: "true"' },
        max_results: { type: 'string', description: 'Max results to return (default: "20", max: "50")' },
        file_extension: { type: 'string', description: 'Filter by file extension (e.g., "md", "yaml")' },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web using Serper API. Returns search results with titles, links, and snippets. Requires SERPER_API_KEY to be configured. When the query mentions a time frame (e.g., "last 24 hours", "this week", "recent"), use the recency parameter to filter results.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (do not include time phrases like "last 24 hours" - use recency parameter instead)' },
        num_results: { type: 'string', description: 'Number of results to return (default: "10", max: "20")' },
        recency: { type: 'string', description: 'IMPORTANT: Use this when searching for recent content. Examples: "hour", "day", "24 hours", "3 days", "week", "month", "year"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'spawn_subagent',
    description: 'Spawn 1-3 sub-agents to work on tasks in parallel. Each sub-agent runs independently with its own context and full tool access. Use when a task can be broken into independent subtasks that benefit from parallel execution (e.g., researching different topics, analyzing from multiple angles). Results from all sub-agents are returned when all complete. Sub-agents cannot spawn their own sub-agents.',
    input_schema: {
      type: 'object',
      properties: {
        agents: { type: 'string', description: 'JSON array of 1-3 sub-agent configs. Each config: {"name": "short label", "prompt": "task description", "model": "optional provider/model-id", "system_prompt": "optional role"}. Example: [{"name": "Research", "prompt": "Find recent papers on X"}, {"name": "Analysis", "prompt": "Analyze the implications of Y", "model": "anthropic/claude-sonnet-4-5-20250929"}]' },
      },
      required: ['agents'],
    },
  },
  {
    name: 'append_to_note',
    description: 'Append content to a note with provenance tracking. Content is automatically marked with a provenance ID linking it to this chat message. Use for capturing insights, ideas, to-dos as the user talks. Keep appends small and atomic (1-3 lines typically).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within vault notes/ directory. Use human-readable names with spaces (e.g., "notes/Project ideas.md", not "notes/project-ideas.md")' },
        content: { type: 'string', description: 'Content to append. Do NOT include provenance markers - they are added automatically.' },
      },
      required: ['path', 'content'],
    },
  },
];
