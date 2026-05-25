/**
 * Background conversation helpers.
 *
 * The orchestrator + parallel-task feature is currently stubbed in
 * `contexts/BackgroundContext.tsx` (see Phase 3 commit). Only the
 * conversation-id helpers remain — they're used to identify the
 * `_background-YYYY-MM-DD.yaml` files in the vault for rendering.
 */

/**
 * Get today's background conversation ID.
 * Each day gets its own file: `_background-YYYY-MM-DD`.
 */
export function getBackgroundConversationId(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `_background-${yyyy}-${mm}-${dd}`;
}

/**
 * Check if a conversation ID is a background conversation (any day).
 */
export function isBackgroundConversation(id: string): boolean {
  return id === '_background' || id.startsWith('_background-');
}
