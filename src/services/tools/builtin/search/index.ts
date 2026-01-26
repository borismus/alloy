import { SearchProvider } from './types';
import { SerperProvider } from './serper';
import { SearXNGProvider } from './searxng';

export type { SearchProvider, SearchResult, SearchOptions } from './types';
export { SerperProvider } from './serper';
export { SearXNGProvider } from './searxng';

export interface SearchConfig {
  SEARCH_PROVIDER?: string;
  SEARXNG_URL?: string;
  SERPER_API_KEY?: string;
}

export type SearchProviderError = {
  type: 'missing_config';
  message: string;
};

export function isSearchProviderError(
  result: SearchProvider | SearchProviderError
): result is SearchProviderError {
  return 'type' in result && result.type === 'missing_config';
}

export function getSearchProvider(
  config: SearchConfig
): SearchProvider | SearchProviderError {
  const provider = config.SEARCH_PROVIDER || 'serper';

  switch (provider) {
    case 'searxng':
      if (!config.SEARXNG_URL) {
        return {
          type: 'missing_config',
          message:
            'SEARXNG_URL not configured. Add it to your config.yaml (e.g., SEARXNG_URL: http://localhost:8080). Self-host with: docker run -d -p 8080:8080 searxng/searxng',
        };
      }
      return new SearXNGProvider(config.SEARXNG_URL);

    case 'serper':
    default:
      if (!config.SERPER_API_KEY) {
        return {
          type: 'missing_config',
          message: 'SERPER_API_KEY not configured. Add it to your config.yaml file.',
        };
      }
      return new SerperProvider(config.SERPER_API_KEY);
  }
}
