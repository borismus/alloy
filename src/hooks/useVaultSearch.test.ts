import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchVault, type VaultSearchHit } from '../services/vaultSearch';
import { useVaultSearch, vaultSearchHitKey } from './useVaultSearch';

vi.mock('../services/vaultSearch', () => ({ searchVault: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const hit = (id: string, snippet: string): VaultSearchHit => ({
  type: 'conversation',
  id,
  title: id,
  snippet,
});

beforeEach(() => {
  vi.mocked(searchVault).mockReset();
});

describe('useVaultSearch', () => {
  it('does not request one-character queries', () => {
    const { result } = renderHook(() => useVaultSearch('x'));
    expect(searchVault).not.toHaveBeenCalled();
    expect(result.current.matches.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('keeps snippets and distinguishes timeline item types', async () => {
    vi.mocked(searchVault).mockResolvedValue([
      hit('shared-id', 'conversation context'),
      { type: 'note', id: 'shared-id', title: 'Note', snippet: 'note context' },
      { type: 'riff', id: 'draft.md', title: 'Draft', snippet: 'riff context' },
    ]);

    const { result } = renderHook(() => useVaultSearch('context'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.matches.get(vaultSearchHitKey('conversation', 'shared-id'))?.snippet)
      .toBe('conversation context');
    expect(result.current.matches.get(vaultSearchHitKey('note', 'shared-id'))?.snippet)
      .toBe('note context');
    expect(result.current.matches.get(vaultSearchHitKey('riff', 'draft.md'))?.snippet)
      .toBe('riff context');
  });

  it('clears old matches and ignores a stale response after the query changes', async () => {
    const beta = deferred<VaultSearchHit[]>();
    const gamma = deferred<VaultSearchHit[]>();
    vi.mocked(searchVault)
      .mockResolvedValueOnce([hit('alpha', 'old result')])
      .mockReturnValueOnce(beta.promise)
      .mockReturnValueOnce(gamma.promise);

    const { result, rerender } = renderHook(
      ({ query }) => useVaultSearch(query),
      { initialProps: { query: 'alpha' } },
    );
    await waitFor(() => expect(result.current.matches.has('conversation:alpha')).toBe(true));

    rerender({ query: 'beta' });
    expect(result.current.matches.size).toBe(0);
    expect(result.current.loading).toBe(true);

    // Move on again while beta's request is still running.
    rerender({ query: 'gamma' });
    act(() => gamma.resolve([hit('gamma', 'new result')]));
    await waitFor(() => expect(result.current.matches.has('conversation:gamma')).toBe(true));

    // A fetch implementation may resolve despite abort. It still must not
    // overwrite the result associated with the current query.
    act(() => beta.resolve([hit('beta-late', 'stale result')]));
    expect(result.current.matches.has('conversation:gamma')).toBe(true);
    expect(result.current.matches.has('conversation:beta-late')).toBe(false);
  });
});
