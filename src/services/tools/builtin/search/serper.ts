import { SearchProvider, SearchOptions, SearchResult } from './types';

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

// Map time units to Serper's tbs format
const TIME_UNIT_MAP: Record<string, string> = {
  hour: 'h',
  hours: 'h',
  day: 'd',
  days: 'd',
  week: 'w',
  weeks: 'w',
  month: 'm',
  months: 'm',
  year: 'y',
  years: 'y',
};

// Parse recency string like "3 days", "week", "2 hours" into tbs parameter
function parseRecency(recency: string): string | null {
  const trimmed = recency.trim().toLowerCase();

  // Try to match pattern like "3 days" or "2 weeks"
  const match = trimmed.match(/^(\d+)\s*(\w+)$/);
  if (match) {
    const count = parseInt(match[1], 10);
    const unit = match[2];
    const tbsUnit = TIME_UNIT_MAP[unit];
    if (tbsUnit) {
      return `qdr:${tbsUnit}${count > 1 ? count : ''}`;
    }
  }

  // Try single word like "day", "week", "month"
  const tbsUnit = TIME_UNIT_MAP[trimmed];
  if (tbsUnit) {
    return `qdr:${tbsUnit}`;
  }

  return null;
}

export class SerperProvider implements SearchProvider {
  name = 'serper';

  constructor(private apiKey: string) {}

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, numResults = 10, recency } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

    try {
      // Build request body
      const requestBody: Record<string, unknown> = {
        q: query,
        num: Math.min(Math.max(1, numResults), 20),
      };

      // Add time filter if specified
      if (recency) {
        const tbs = parseRecency(recency);
        if (tbs) {
          requestBody.tbs = tbs;
        }
      }

      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
      }

      const data: SerperResponse = await response.json();

      if (!data.organic || data.organic.length === 0) {
        return [];
      }

      // Map to common SearchResult format
      return data.organic.slice(0, numResults).map((result, idx) => ({
        position: idx + 1,
        title: result.title,
        url: result.link,
        snippet: result.snippet,
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
