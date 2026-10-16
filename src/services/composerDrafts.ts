import { useSyncExternalStore } from 'react';

/**
 * Unsent composer text, per conversation.
 *
 * Stored in localStorage rather than the vault: a draft changes on every
 * keystroke, and writing the synced vault that often would churn files and
 * race between devices. Drafts therefore stay on the device they were typed on.
 */

const STORAGE_KEY = 'alloy.composerDrafts';

let drafts: Record<string, string> = load();
// Which conversations have a draft. Replaced only when that membership changes,
// so the sidebar re-renders when a draft starts or clears, not per keystroke.
let draftIds: ReadonlySet<string> = new Set(Object.keys(drafts));
const listeners = new Set<() => void>();

function load(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    // Unavailable or corrupt storage — start empty rather than fail.
    return {};
  }
}

export function getComposerDraft(conversationId: string | null | undefined): string {
  return conversationId ? drafts[conversationId] ?? '' : '';
}

/** Save `text` as the conversation's draft; blank text clears it. */
export function setComposerDraft(conversationId: string | null | undefined, text: string): void {
  if (!conversationId) return;
  const hasText = text.trim() !== '';
  if (hasText ? drafts[conversationId] === text : !(conversationId in drafts)) return;

  const membershipChanged = hasText !== draftIds.has(conversationId);
  if (hasText) drafts[conversationId] = text;
  else delete drafts[conversationId];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Non-fatal: the draft still survives thread switches until reload.
  }
  if (membershipChanged) {
    draftIds = new Set(Object.keys(drafts));
    listeners.forEach(listener => listener());
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ids of conversations with unsent text; re-renders only when that set changes. */
export function useComposerDraftIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => draftIds);
}

/** Test-only: forget in-memory drafts and re-read storage. */
export function resetComposerDraftsForTest(): void {
  drafts = load();
  draftIds = new Set(Object.keys(drafts));
}
