import { fetch } from '@tauri-apps/plugin-http';
import { SearchProvider, SearchOptions, SearchResult } from './types';

const HTTP_TIMEOUT = 15000; // 15 seconds for search

interface SearXNGResult {
  url: string;
  title: string;
  content: string;
  score?: number;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

export class SearXNGProvider implements SearchProvider {
  name = 'searxng';

  constructor(private baseUrl: string) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, numResults = 10 } = options;
    // Note: SearXNG doesn't have a direct recency filter like Serper's tbs

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
      });

      const response = await fetch(`${this.baseUrl}/search?${params}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(
            'SearXNG instance does not allow JSON format. Try a different instance or enable JSON in settings.'
          );
        }
        throw new Error(`SearXNG API error: ${response.status} ${response.statusText}`);
      }

      const data: SearXNGResponse = await response.json();

      if (!data.results || data.results.length === 0) {
        return [];
      }

      // Sort by score if available, then take top N results
      const sortedResults = [...data.results].sort((a, b) => (b.score || 0) - (a.score || 0));

      // Map to common SearchResult format
      return sortedResults.slice(0, numResults).map((result, idx) => ({
        position: idx + 1,
        title: result.title || '',
        url: result.url,
        snippet: result.content || '',
      }));
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Search request timed out after 15 seconds');
      }
      throw error;
    }
  }
}
