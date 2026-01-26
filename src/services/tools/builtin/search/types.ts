export interface SearchResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  numResults?: number;
  recency?: string; // time filter (e.g., "day", "week", "3 days")
}

export interface SearchProvider {
  name: string;
  search(options: SearchOptions): Promise<SearchResult[]>;
}
