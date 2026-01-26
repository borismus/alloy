import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';
import { getSearchProvider, isSearchProviderError, SearchConfig } from './search/index';

export async function executeWebSearchTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'web_search':
      return await webSearch(
        input.query as string,
        input.num_results as string | undefined,
        input.recency as string | undefined
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
  numResultsStr?: string,
  recency?: string
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
    // Get config
    const config = (await vaultService.loadConfig()) as unknown as SearchConfig;

    // Get the appropriate search provider
    const providerOrError = getSearchProvider(config);

    // Check if we got an error instead of a provider
    if (isSearchProviderError(providerOrError)) {
      return {
        tool_use_id: '',
        content: providerOrError.message,
        is_error: true,
      };
    }

    const provider = providerOrError;

    // Perform the search
    const results = await provider.search({ query, numResults, recency });

    if (results.length === 0) {
      return {
        tool_use_id: '',
        content: `No results found for: "${query}"`,
      };
    }

    return {
      tool_use_id: '',
      content: JSON.stringify({ query, results }, null, 2),
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}
