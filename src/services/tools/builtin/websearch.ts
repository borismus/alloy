import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';

const HTTP_TIMEOUT = 15000; // 15 seconds for search

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface SerperResponse {
  organic?: SerperResult[];
  searchParameters?: {
    q: string;
  };
}

export async function executeWebSearchTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'web_search':
      return await webSearch(
        input.query as string,
        input.num_results as string | undefined
      );
    default:
      return {
        tool_use_id: '',
        content: `Unknown web search tool: ${toolName}`,
        is_error: true,
      };
  }
}

async function webSearch(
  query: string,
  numResultsStr?: string
): Promise<ToolResult> {
  if (!query) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: query',
      is_error: true,
    };
  }

  // Parse num_results with bounds
  let numResults = 10;
  if (numResultsStr) {
    const parsed = parseInt(numResultsStr, 10);
    if (!isNaN(parsed)) {
      numResults = Math.min(Math.max(1, parsed), 20);
    }
  }

  try {
    // Get API key from config
    const config = await vaultService.loadConfig();
    const apiKey = (config as unknown as Record<string, unknown>)?.SERPER_API_KEY as string | undefined;

    if (!apiKey) {
      return {
        tool_use_id: '',
        content: 'SERPER_API_KEY not configured. Add it to your vault config.yaml file.',
        is_error: true,
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({
        q: query,
        num: numResults,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        tool_use_id: '',
        content: `Search API error: ${response.status} ${response.statusText}`,
        is_error: true,
      };
    }

    const data: SerperResponse = await response.json();

    if (!data.organic || data.organic.length === 0) {
      return {
        tool_use_id: '',
        content: `No results found for: "${query}"`,
      };
    }

    // Format results
    const results = data.organic.slice(0, numResults).map((result, idx) => ({
      position: idx + 1,
      title: result.title,
      url: result.link,
      snippet: result.snippet,
    }));

    return {
      tool_use_id: '',
      content: JSON.stringify({ query, results }, null, 2),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        tool_use_id: '',
        content: 'Search request timed out after 15 seconds',
        is_error: true,
      };
    }
    return {
      tool_use_id: '',
      content: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}
