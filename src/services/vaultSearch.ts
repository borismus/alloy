import { getEmbeddedApiBase } from './tauri-bootstrap';

/**
 * Full-text search across the vault, run server-side.
 *
 * The sidebar filter can only match what the client already holds. Notes are
 * fully loaded so they search fine, but conversations arrive as metadata-only
 * summaries with `messages: []` — so searching message text silently matched
 * nothing until a conversation had been opened. Shipping every transcript to
 * the client isn't an option (a real vault is ~200MB), so the scan happens next
 * to the files and only matches come back.
 */

export interface VaultSearchHit {
  /** Mirrors the timeline item kinds. */
  type: 'conversation' | 'note';
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
