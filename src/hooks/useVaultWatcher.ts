import { useEffect, useRef, useCallback } from 'react';
import { watch, WatchEvent, WatchEventKind, exists } from '@tauri-apps/plugin-fs';
// Imported from the shim directly rather than through the '@tauri-apps/plugin-fs'
// alias: this is an Alloy-specific signal with no counterpart in the real Tauri
// plugin, so the upstream types don't declare it. Both names resolve to this
// same module in every build (see the alias in vite.config.ts).
import { onWatchReconnect } from '../services/api/tauri-fs-http';
import { extractCoreId } from '../services/vault';

export interface VaultWatcherCallbacks {
  onConversationAdded: (id: string) => void;
  onConversationRemoved: (id: string) => void;
  onConversationModified: (id: string) => void;
  onMemoryChanged?: () => void;
  onConfigChanged: () => void;
  onNoteAdded?: (filename: string) => void;
  onNoteRemoved?: (filename: string) => void;
  onNoteModified?: (filename: string) => void;
  onTaskAdded?: (id: string) => void;
  onTaskRemoved?: (id: string) => void;
  onTaskModified?: (id: string) => void;
  /**
   * Re-read the vault because live events may have been missed. The watcher
   * only receives events while connected, and nothing is replayed for the gap,
   * so a dropped socket silently loses every change made while it was down.
   * Fires on reconnect and on returning to the foreground.
   */
  onResync?: () => void;
}

export interface UseVaultWatcherOptions {
  vaultPath: string | null;
  enabled: boolean;
  debounceMs?: number;
}

export interface UseVaultWatcherResult {
  isWatching: boolean;
  markSelfWrite: (filePath: string) => void;
}

const SELF_WRITE_WINDOW_MS = 2000;

/** Coalesce window for resync triggers that tend to arrive together. */
const RESYNC_DEBOUNCE_MS = 250;

type EventType = 'create' | 'modify' | 'remove' | 'rename' | 'other';

function getEventType(kind: WatchEventKind): EventType {
  if (kind === 'any' || kind === 'other') {
    return 'other';
  }
  if (typeof kind === 'object') {
    if ('create' in kind) return 'create';
    if ('remove' in kind) return 'remove';
    if ('modify' in kind) {
      // On macOS, file deletion shows as modify with kind: "rename"
      // We'll return 'rename' so we can handle it specially
      const modifyKind = kind.modify;
      if (typeof modifyKind === 'object' && 'kind' in modifyKind && modifyKind.kind === 'rename') {
        return 'rename' as EventType;
      }
      return 'modify';
    }
  }
  return 'other';
}

export function useVaultWatcher(
  options: UseVaultWatcherOptions,
  callbacks: VaultWatcherCallbacks
): UseVaultWatcherResult {
  const { vaultPath, enabled, debounceMs = 500 } = options;

  const isWatchingRef = useRef(false);
  const recentSelfWrites = useRef<Map<string, number>>(new Map());
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref up to date
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const markSelfWrite = useCallback((filePath: string) => {
    recentSelfWrites.current.set(filePath, Date.now());
    // Clean up old entries
    const now = Date.now();
    for (const [path, timestamp] of recentSelfWrites.current.entries()) {
      if (now - timestamp > SELF_WRITE_WINDOW_MS * 2) {
        recentSelfWrites.current.delete(path);
      }
    }
  }, []);

  const isSelfWrite = useCallback((filePath: string): boolean => {
    const timestamp = recentSelfWrites.current.get(filePath);
    if (!timestamp) return false;
    if (Date.now() - timestamp < SELF_WRITE_WINDOW_MS) return true;
    recentSelfWrites.current.delete(filePath);
    return false;
  }, []);

  const extractConversationId = useCallback((filePath: string): string | null => {
    const filename = filePath.split('/').pop() || '';
    if (!filename.endsWith('.yaml')) return null;
    return extractCoreId(filename);
  }, []);

  // Same ID extraction logic works for tasks (same filename format).
  const extractTaskId = extractConversationId;

  useEffect(() => {
    if (!vaultPath || !enabled) {
      isWatchingRef.current = false;
      return;
    }

    let unwatchFn: (() => void) | null = null;
    let isMounted = true;

    const handleEvent = async (event: WatchEvent) => {
      if (!isMounted) return;

      const { type, paths } = event;
      const eventType = getEventType(type);

      for (const filePath of paths) {
        // Skip if this was our own write
        if (isSelfWrite(filePath)) {
          continue;
        }

        // Determine what type of file changed
        const isConversationFile =
          filePath.includes('/conversations/') &&
          filePath.endsWith('.yaml');
        const isMemoryFile = filePath.endsWith('memory.md');
        const isConfigFile = filePath.endsWith('config.yaml');
        const isNoteFile =
          (filePath.includes('/notes/') || filePath.includes('/riffs/')) &&
          filePath.endsWith('.md');
        const isRiffFile = filePath.includes('/riffs/');
        const isTaskFile =
          filePath.includes('/tasks/') &&
          filePath.endsWith('.yaml');

        // Skip .md files in conversations (auto-generated previews)
        if (filePath.includes('/conversations/') && filePath.endsWith('.md')) {
          continue;
        }

        if (isConversationFile) {
          const conversationId = extractConversationId(filePath);
          if (!conversationId) continue;

          // For rename events (macOS deletion), check if file still exists
          let effectiveEventType = eventType;
          if (eventType === 'rename') {
            const fileExists = await exists(filePath);
            effectiveEventType = fileExists ? 'modify' : 'remove';
          }

          switch (effectiveEventType) {
            case 'create':
              callbacksRef.current.onConversationAdded(conversationId);
              break;
            case 'remove':
              callbacksRef.current.onConversationRemoved(conversationId);
              break;
            case 'modify':
              callbacksRef.current.onConversationModified(conversationId);
              break;
          }
        } else if (isMemoryFile) {
          if (eventType === 'modify' || eventType === 'create') {
            callbacksRef.current.onMemoryChanged?.();
          }
        } else if (isConfigFile) {
          if (eventType === 'modify' || eventType === 'create') {
            callbacksRef.current.onConfigChanged();
          }
        } else if (isNoteFile) {
          // For riff files, include the riffs/ prefix in filename
          const baseFilename = filePath.split('/').pop() || '';
          const filename = isRiffFile ? `riffs/${baseFilename}` : baseFilename;
          // For rename events (macOS deletion), check if file still exists
          let effectiveEventType = eventType;
          if (eventType === 'rename') {
            const fileExists = await exists(filePath);
            effectiveEventType = fileExists ? 'modify' : 'remove';
          }

          switch (effectiveEventType) {
            case 'create':
              callbacksRef.current.onNoteAdded?.(filename);
              break;
            case 'remove':
              callbacksRef.current.onNoteRemoved?.(filename);
              break;
            case 'modify':
              callbacksRef.current.onNoteModified?.(filename);
              break;
          }
        } else if (isTaskFile) {
          const taskId = extractTaskId(filePath);
          if (!taskId) continue;

          // For rename events (macOS deletion), check if file still exists
          let effectiveEventType = eventType;
          if (eventType === 'rename') {
            const fileExists = await exists(filePath);
            effectiveEventType = fileExists ? 'modify' : 'remove';
          }

          switch (effectiveEventType) {
            case 'create':
              callbacksRef.current.onTaskAdded?.(taskId);
              break;
            case 'remove':
              callbacksRef.current.onTaskRemoved?.(taskId);
              break;
            case 'modify':
              callbacksRef.current.onTaskModified?.(taskId);
              break;
          }
        }
      }
    };

    const startWatching = async () => {
      try {
        unwatchFn = await watch(
          vaultPath,
          handleEvent,
          { recursive: true, delayMs: debounceMs }
        );
        if (isMounted) {
          isWatchingRef.current = true;
        }
      } catch (error) {
        console.error('Failed to start vault watcher:', error);
        isWatchingRef.current = false;
      }
    };

    startWatching();

    // Catch up on anything missed while disconnected. Two triggers, because
    // neither alone is sufficient on mobile: `onWatchReconnect` covers a socket
    // that closed and came back, while foregrounding covers iOS leaving a
    // half-open socket that reports OPEN with no data flowing, where `onclose`
    // never fires and no reconnect is ever attempted.
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const requestResync = () => {
      if (!isMounted) return;
      // Coalesce: foregrounding often fires visibility + focus together, and a
      // reconnect can land in the same tick.
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        if (isMounted) callbacksRef.current.onResync?.();
      }, RESYNC_DEBOUNCE_MS);
    };

    const unsubscribeReconnect = onWatchReconnect?.(requestResync);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestResync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', requestResync);

    return () => {
      isMounted = false;
      isWatchingRef.current = false;
      if (resyncTimer) clearTimeout(resyncTimer);
      unsubscribeReconnect?.();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', requestResync);
      if (unwatchFn) {
        unwatchFn();
      }
    };
  }, [vaultPath, enabled, debounceMs, isSelfWrite, extractConversationId, extractTaskId]);

  return {
    isWatching: isWatchingRef.current,
    markSelfWrite,
  };
}
