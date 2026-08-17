import { useEffect, useRef, useState } from 'react';
import { searchVault, type VaultSearchHit } from '../services/vaultSearch';

export type VaultSearchMatches = Map<string, VaultSearchHit>;

export function vaultSearchHitKey(type: VaultSearchHit['type'], id: string): string {
  return `${type}:${id}`;
}

interface SearchState {
  query: string;
  matches: VaultSearchMatches;
  loading: boolean;
  error: Error | null;
}

const EMPTY_MATCHES: VaultSearchMatches = new Map();

/**
 * Debounced queries are owned by the caller; this hook owns request lifetime.
 * Results are tagged with the query that produced them so an old response can
 * never appear under newer input, even if aborting the underlying fetch races
 * with the response.
 */
export function useVaultSearch(query: string): Omit<SearchState, 'query'> {
  const normalizedQuery = query.trim();
  const requestId = useRef(0);
  const [state, setState] = useState<SearchState>({
    query: '',
    matches: EMPTY_MATCHES,
    loading: false,
    error: null,
  });

  useEffect(() => {
    const id = ++requestId.current;
    if (normalizedQuery.length < 2) return;

    // The query tag in the render path clears previous results immediately;
    // avoid a synchronous state update here just to represent that derived
    // state. Only network completion writes state.
    const controller = new AbortController();

    searchVault(normalizedQuery, controller.signal)
      .then(hits => {
        if (requestId.current !== id) return;
        const matches = new Map(
          hits.map(hit => [vaultSearchHitKey(hit.type, hit.id), hit]),
        );
        setState({ query: normalizedQuery, matches, loading: false, error: null });
      })
      .catch(error => {
        if (requestId.current !== id || (error as Error)?.name === 'AbortError') return;
        setState({
          query: normalizedQuery,
          matches: EMPTY_MATCHES,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    return () => {
      controller.abort();
      // Also invalidate implementations that resolve despite abort, including
      // after this component unmounts.
      requestId.current = id + 1;
    };
  }, [normalizedQuery]);

  // Effects run after render. This guard clears an old query during that render,
  // before the effect above has had a chance to replace state.
  if (state.query !== normalizedQuery) {
    return {
      matches: EMPTY_MATCHES,
      loading: normalizedQuery.length >= 2,
      error: null,
    };
  }
  return { matches: state.matches, loading: state.loading, error: state.error };
}
