import { getEmbeddedApiBase } from './tauri-bootstrap';

/**
 * Full-text search across the vault, run server-side.
 *
 * The sidebar filter can only match what the client already holds. Notes and
 * conversation bodies are deliberately loaded on demand, not shipped with the
 * timeline metadata. The scan therefore happens next to the files and only
 * matches come back.
 */

export interface VaultSearchHit {
  /** Mirrors the timeline item kinds. */
  type: 'conversation' | 'note' | 'riff';
  /** Conversation id, or vault-relative path for a note/riff. */
  id: string;
  title: string;
  snippet: string;
}

export async function searchVault(query: string, signal?: AbortSignal): Promise<VaultSearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const url = `${getEmbeddedApiBase()}/api/search?q=${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { results?: VaultSearchHit[] };
  return body.results ?? [];
}
