import { useEffect, useRef, useCallback } from 'react';
import { watch, WatchEvent, WatchEventKind, exists } from '@tauri-apps/plugin-fs';

export interface VaultWatcherCallbacks {
  onConversationAdded: (id: string) => void;
  onConversationRemoved: (id: string) => void;
  onConversationModified: (id: string) => void;
  onMemoryChanged?: () => void;
  onConfigChanged: () => void;
  onNoteAdded?: (filename: string) => void;
  onNoteRemoved?: (filename: string) => void;
  onNoteModified?: (filename: string) => void;
  onTriggerAdded?: (id: string) => void;
  onTriggerRemoved?: (id: string) => void;
  onTriggerModified?: (id: string) => void;
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
    // Extract core ID (YYYY-MM-DD-HHMM-hash) from filename
    // Input: "2025-01-14-1430-a1b2-my-topic.yaml"
    // Output: "2025-01-14-1430-a1b2"
    const name = filename.replace(/\.yaml$/, '');
    const parts = name.split('-');
    if (parts.length >= 5) {
      return parts.slice(0, 5).join('-');
    }
    return name; // Return as-is if doesn't match expected format
  }, []);

  // Same ID extraction logic works for triggers (same filename format)
  const extractTriggerId = extractConversationId;

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

      // Debug logging
      console.log('[VaultWatcher] Event:', { type, eventType, paths });

      for (const filePath of paths) {
        // Skip if this was our own write
        if (isSelfWrite(filePath)) {
          console.log('[VaultWatcher] Skipping self-write:', filePath);
          continue;
        }

        // Determine what type of file changed
        const isConversationFile =
          filePath.includes('/conversations/') &&
          filePath.endsWith('.yaml');
        const isMemoryFile = filePath.endsWith('memory.md');
        const isConfigFile = filePath.endsWith('config.yaml');
        const isNoteFile =
          (filePath.includes('/notes/') || filePath.includes('/rambles/')) &&
          filePath.endsWith('.md');
        const isRambleFile = filePath.includes('/rambles/');
        const isTriggerFile =
          filePath.includes('/triggers/') &&
          filePath.endsWith('.yaml') &&
          !filePath.endsWith('logs.yaml');

        // Skip .md files in conversations (auto-generated previews)
        if (filePath.includes('/conversations/') && filePath.endsWith('.md')) {
          continue;
        }

        if (isConversationFile) {
          const conversationId = extractConversationId(filePath);
          if (!conversationId) continue;

          console.log('[VaultWatcher] Conversation event:', { eventType, conversationId, filePath });

          // For rename events (macOS deletion), check if file still exists
          let effectiveEventType = eventType;
          if (eventType === 'rename') {
            const fileExists = await exists(filePath);
            effectiveEventType = fileExists ? 'modify' : 'remove';
            console.log('[VaultWatcher] Rename event - file exists:', fileExists, '-> treating as:', effectiveEventType);
          }

          switch (effectiveEventType) {
            case 'create':
              callbacksRef.current.onConversationAdded(conversationId);
              break;
            case 'remove':
              console.log('[VaultWatcher] Calling onConversationRemoved for:', conversationId);
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
          // For ramble files, include the rambles/ prefix in filename
          const baseFilename = filePath.split('/').pop() || '';
          const filename = isRambleFile ? `rambles/${baseFilename}` : baseFilename;
          console.log('[VaultWatcher] Note event:', { eventType, filename, filePath });

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
        } else if (isTriggerFile) {
          const triggerId = extractTriggerId(filePath);
          if (!triggerId) continue;

          console.log('[VaultWatcher] Trigger event:', { eventType, triggerId, filePath });

          // For rename events (macOS deletion), check if file still exists
          let effectiveEventType = eventType;
          if (eventType === 'rename') {
            const fileExists = await exists(filePath);
            effectiveEventType = fileExists ? 'modify' : 'remove';
          }

          switch (effectiveEventType) {
            case 'create':
              callbacksRef.current.onTriggerAdded?.(triggerId);
              break;
            case 'remove':
              callbacksRef.current.onTriggerRemoved?.(triggerId);
              break;
            case 'modify':
              callbacksRef.current.onTriggerModified?.(triggerId);
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

    return () => {
      isMounted = false;
      isWatchingRef.current = false;
      if (unwatchFn) {
        unwatchFn();
      }
    };
  }, [vaultPath, enabled, debounceMs, isSelfWrite, extractConversationId]);

  return {
    isWatching: isWatchingRef.current,
    markSelfWrite,
  };
}
