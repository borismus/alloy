import React, { useState, useEffect, useRef, useCallback } from 'react';
import { vaultService } from './services/vault';
import { skillRegistry } from './services/skills';
import { riffService } from './services/riff';
import { useVaultWatcher } from './hooks/useVaultWatcher';
import { useIsMobile } from './hooks/useIsMobile';
import { useVisualViewport } from './hooks/useVisualViewport';
import { useToasts } from './hooks/useToasts';
import { useNavigation } from './hooks/useNavigation';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useStreamingContext, StreamingProvider } from './contexts/StreamingContext';
import { MessageQueueProvider } from './contexts/MessageQueueContext';
import { TaskProvider } from './contexts/TaskContext';
import { Conversation, Config, Message, ProviderType, ModelInfo, Attachment, NoteInfo, TimelineFilter, TimelineItem, ScheduledTask } from './types';
import { useSendMessage } from './hooks/useSendMessage';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { Sidebar, SidebarHandle } from './components/Sidebar';
import { Settings } from './components/Settings';
import { NoteViewer } from './components/NoteViewer';
import { FindInConversation, FindInConversationHandle } from './components/FindInConversation';
// MobileNewConversation removed - ChatInterface handles both new and existing conversations
import { UpdateChecker } from './components/UpdateChecker';
import { MemoryWarning } from './components/MemoryWarning';
import { isTauri } from './services/api';
import { openInEditor, type ExternalEditor } from './utils/openInEditor';
import { reconnectToActiveSessions } from './services/server-streaming';
import { getEmbeddedApiBase, loadEmbeddedServerUrl, setEmbeddedVaultPath } from './services/tauri-bootstrap';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { RiffProvider, useRiffContext } from './contexts/RiffContext';
import { RiffBatchApprovalModal } from './components/RiffBatchApprovalModal';
import { RiffView } from './components/RiffView';
import { ContextMenu } from './components/ContextMenu';
import { ToastContainer } from './components/Toast';
import './App.css';

const TaskDetailView = React.lazy(() =>
  import('./components/TaskDetailView').then(module => ({ default: module.TaskDetailView }))
);

// Error boundary to catch render errors and prevent white screen
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'system-ui' }}>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ color: '#888', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid #555',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}


/**
 * True when an error came from `fetch` failing to reach the server (rather
 * than the server returning a 4xx/5xx). Used to distinguish "backend down"
 * from "vault is broken" in init so we can show the right UI.
 */
function isBackendUnreachable(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('failed to fetch')
      || msg.includes('networkerror')
      || msg.includes('load failed')
      || msg.includes('econnrefused');
  }
  return false;
}

async function fetchAvailableModelList(): Promise<ModelInfo[]> {
  const res = await fetch(`${getEmbeddedApiBase()}/api/models`);
  if (!res.ok) throw new Error(`Model discovery failed: HTTP ${res.status}`);
  return res.json();
}

function modelListsMatch(a: ModelInfo[], b: ModelInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((model, index) => {
    const other = b[index];
    return model.key === other.key
      && model.name === other.name
      && model.provider === other.provider
      && model.local === other.local
      && model.contextWindow === other.contextWindow;
  });
}

/**
 * Merge a disk-loaded conversation with the in-memory copy, re-appending any
 * trailing in-memory USER messages whose ids aren't on disk yet. Guards against
 * a watcher reload wiping an optimistic (queued) user message that hasn't been
 * persisted when the reload fires. Assistant messages stay disk-authoritative.
 */
function preserveOptimisticUserMessages(disk: Conversation, mem: Conversation | null | undefined): Conversation {
  if (!mem) return disk;
  const diskIds = new Set(disk.messages.map(m => m.id).filter(Boolean));
  const extras = mem.messages.filter(m => m.id && !diskIds.has(m.id) && m.role === 'user');
  if (extras.length === 0) return disk;
  return { ...disk, messages: [...disk.messages, ...extras] };
}

function AppContent() {
  useVisualViewport();
  const [config, setConfig] = useState<Config | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Mirror of `conversations` for stale-free reads in async loaders/callbacks.
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Set when the backend is unreachable on init (vs. real config errors). We
  // keep the saved vaultPath in localStorage so a retry / page reload works
  // the moment the backend comes back, instead of dumping the user to vault
  // setup like a fresh install.
  const [initError, setInitError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);

  // Navigation state (selectedItem, back/forward, sessionStorage persistence)
  const { selectedItem, setSelectedItem, navigateTo, goBack: goBackRaw, canGoBack } = useNavigation();
  const goBack = useCallback(() => goBackRaw(setNoteContent, () => setDraftConversation(null)), [goBackRaw]);

  // Cached note content (loaded on demand when note is selected)
  const [noteContent, setNoteContent] = useState<string | null>(null);
  // Transient conversation state for new/unsaved conversations
  const [draftConversation, setDraftConversation] = useState<Conversation | null>(null);
  // Memory content and size for system prompt injection
  const [memory, setMemory] = useState<{ content: string; sizeBytes: number } | null>(null);
  // Toast notifications
  const { toasts, showToast, dismissToast } = useToasts();

  // Derive selected items from lists based on selectedItem
  const currentConversation = selectedItem?.type === 'conversation'
    ? (draftConversation?.id === selectedItem.id ? draftConversation : conversations.find(c => c.id === selectedItem.id)) ?? null
    : null;
  const selectedTask = selectedItem?.type === 'task'
    ? tasks.find(t => t.id === selectedItem.id) ?? null
    : null;
  const selectedNote = selectedItem?.type === 'note' && noteContent !== null
    ? { filename: selectedItem.id, content: noteContent }
    : null;

  // Mobile navigation state
  const isMobile = useIsMobile();
  type MobileView = 'list' | 'conversation';
  const [mobileView, setMobileView] = useState<MobileView>(() => {
    // Restore mobile view on reload (mobile Safari discards pages when backgrounded)
    try {
      const saved = sessionStorage.getItem('selectedItem');
      if (saved && JSON.parse(saved)) return 'conversation';
    } catch { /* ignore */ }
    return 'list';
  });

  // Check if selected note is a draft (for mobile riff mode)
  const isViewingDraft = selectedNote?.filename.startsWith('riffs/') &&
    !selectedNote.content.includes('integrated: true');

  // Message ID to scroll to after navigating to a conversation (for provenance links)
  const [pendingScrollToMessageId, setPendingScrollToMessageId] = useState<string | null>(null);
  const chatInterfaceRef = useRef<ChatInterfaceHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<FindInConversationHandle>(null);
  const [showFind, setShowFind] = useState(false);
  const {
    startStreaming, updateStreamingContent,
    setStreamingThinkingState, updateStreamingThinking, finishStreamingThinking,
    completeStreaming, stopStreaming,
    getStreamingConversationIds, getUnreadConversationIds, markAsRead, addToolUse,
    startSubagents, updateSubagentContent, addSubagentToolUse, completeSubagent,
  } = useStreamingContext();
  const riffContext = useRiffContext();

  // Check if selected note is a riff/draft on desktop (not integrated)
  const isRiffNote = selectedNote?.filename.startsWith('riffs/') &&
    !selectedNote.content.includes('integrated: true');

  // Determine if user has selected a non-riff item (conversation, task, or integrated note)
  const hasNonRiffSelection = !!(currentConversation || selectedTask || (selectedNote && (!selectedNote.filename.startsWith('riffs/') || selectedNote.content.includes('integrated: true'))));

  // Auto-enter riff mode when viewing a draft note (desktop)
  useEffect(() => {
    if (!isMobile && isRiffNote && selectedNote) {
      if (!riffContext.isRiffMode || riffContext.draftFilename !== selectedNote.filename) {
        riffContext.enterRiffMode(selectedNote.filename);
      }
    }
  }, [isMobile, isRiffNote, selectedNote, riffContext.isRiffMode, riffContext.draftFilename]);

  // Auto-exit riff mode when user navigates to a non-riff item (desktop)
  useEffect(() => {
    if (!isMobile && riffContext.isRiffMode && hasNonRiffSelection) {
      riffContext.exitRiffMode();
    }
  }, [isMobile, hasNonRiffSelection, riffContext]);

  // Auto-enter riff mode when viewing drafts on mobile
  useEffect(() => {
    if (isMobile && isViewingDraft && selectedNote) {
      if (!riffContext.isRiffMode || riffContext.draftFilename !== selectedNote.filename) {
        riffContext.enterRiffMode(selectedNote.filename);
      }
    }
  }, [isMobile, isViewingDraft, selectedNote, riffContext]);

  // New riff handler (for sidebar)
  const handleNewRiff = useCallback(async () => {
    setSelectedItem(null);
    setNoteContent(null);
    await riffContext.enterRiffMode();
    if (isMobile) setMobileView('conversation');
  }, [riffContext, isMobile]);

  // Integrate handler (for NoteViewer)
  const handleIntegrateNote = useCallback(async (filename: string) => {
    const model = config?.defaultModel || availableModels[0]?.key || '';
    if (model && filename) {
      riffContext.setConfig(model, notes);
      await riffContext.enterRiffMode(filename);
      await riffContext.integrateNow();
    }
  }, [riffContext, config?.favoriteModels, availableModels, notes]);

  // Vault watcher callbacks
  const handleConversationAdded = useCallback(async (id: string) => {
    // Don't resurrect files left by the removed background-mode feature.
    if (id === '_background' || id.startsWith('_background-')) return;
    const newConv = await vaultService.loadConversation(id);
    if (newConv) {
      setConversations(prev => {
        // Avoid duplicates
        if (prev.some(c => c.id === id)) return prev;
        return [newConv, ...prev].sort((a, b) =>
          new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
        );
      });
    }
  }, []);

  const handleConversationRemoved = useCallback(async (id: string) => {
    // A title-change rename arrives from the watcher as remove(old file) +
    // create(new file) with the SAME core id (the slug after the id differs).
    // This happens on a new conversation's first reply, when the generated
    // title replaces the fallback title. If a file for this id still exists,
    // it was renamed, not deleted — don't drop it or clear the selection.
    if (await vaultService.getConversationFilePath(id)) {
      return;
    }
    setConversations(prev => prev.filter(c => c.id !== id));
    // Clear selection if removed conversation was selected
    if (selectedItem?.type === 'conversation' && selectedItem.id === id) {
      setSelectedItem(null);
    }
    setDraftConversation(prev => prev?.id === id ? null : prev);
  }, [selectedItem]);

  const handleConversationModified = useCallback(async (id: string) => {
    const updated = await vaultService.loadConversation(id);
    if (!updated) return;

    // A watcher reload can arrive mid-send (e.g. the backend just persisted the
    // previous turn's reply) while an optimistic user message — like a queued
    // message that just started sending — isn't on disk yet. Re-append those
    // trailing in-memory user messages so the reload doesn't make them vanish
    // until the reply lands.
    //
    // Upsert, not just map: an externally-created file can surface as a `modify`
    // (macOS/FSEvents often coalesces create+write into one modify), so insert
    // it if we haven't seen this id yet rather than dropping it until restart.
    setConversations(prev =>
      prev.some(c => c.id === id)
        ? prev.map(c => c.id === id ? preserveOptimisticUserMessages(updated, c) : c)
        : [updated, ...prev].sort((a, b) =>
            new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
          )
    );
    // currentConversation is derived from conversations, so no need to update separately
    // But if it's a draft conversation, update that too
    setDraftConversation(prev => prev?.id === id ? preserveOptimisticUserMessages(updated, prev) : prev);
  }, []);

  // Lazy-load a conversation's full message bodies on open. The startup list
  // holds metadata-only summaries (messagesLoaded === false); the first time one
  // is viewed we fetch its YAML and swap it into place, then keep it cached.
  const ensureConversationLoaded = useCallback(async (id: string) => {
    const existing = conversationsRef.current.find(c => c.id === id);
    if (existing && existing.messagesLoaded !== false) return; // already full
    const full = await vaultService.loadConversation(id);
    if (!full) return;
    const loaded: Conversation = { ...full, messagesLoaded: true };
    setConversations(prev =>
      prev.some(c => c.id === id) ? prev.map(c => c.id === id ? loaded : c) : prev
    );
  }, []);

  // Load the open conversation's messages when it's selected, and again once the
  // summary list first arrives (covers a selection restored before load).
  useEffect(() => {
    if (selectedItem?.type === 'conversation') {
      ensureConversationLoaded(selectedItem.id);
    }
  }, [selectedItem, conversations.length, ensureConversationLoaded]);

  // Use ref to avoid circular dependency with loadVault
  const loadVaultRef = useRef<((path: string) => Promise<void>) | null>(null);

  const handleConfigChanged = useCallback(async () => {
    const vaultPath = vaultService.getVaultPath();
    if (vaultPath && loadVaultRef.current) {
      await loadVaultRef.current(vaultPath);
    }
  }, []);

  const vaultPath = vaultService.getVaultPath();

  // Note watcher callbacks - reload full list to maintain sort order and skill detection
  const handleNoteChanged = useCallback(async () => {
    const loadedNotes = await vaultService.loadNotes();
    setNotes(loadedNotes);
  }, []);

  // Handle note modification - refresh selected note content if it's the one being viewed
  const handleNoteModified = useCallback(async (filename: string) => {
    // Reload the notes list
    const loadedNotes = await vaultService.loadNotes();
    setNotes(loadedNotes);

    // Refresh memory if memory.md was modified
    if (filename === 'memory.md') {
      const loadedMemory = await vaultService.loadMemory();
      setMemory(loadedMemory);
    }

    // If the modified note is currently selected, refresh its content
    if (selectedItem?.type === 'note' && selectedItem.id === filename) {
      vaultService.readNote(filename).then(content => {
        if (content !== null) setNoteContent(content);
      }).catch(error => {
        console.error('Failed to refresh note content:', error);
      });
    }
  }, [selectedItem]);

  // Task watcher callbacks
  const handleTaskAdded = useCallback(async (id: string) => {
    const newTask = await vaultService.loadTask(id);
    if (newTask) {
      setTasks(prev => {
        // Avoid duplicates
        if (prev.some(t => t.id === id)) return prev;
        return [newTask, ...prev].sort((a, b) =>
          new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
        );
      });
    }
  }, []);

  const handleTaskRemoved = useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  const handleTaskModified = useCallback(async (id: string) => {
    const updated = await vaultService.loadTask(id);
    if (!updated) return;
    // Upsert, not just map: an externally-created task file can surface as a
    // `modify` (macOS coalesces create+write), so insert it if unseen rather
    // than dropping it until restart.
    setTasks(prev =>
      prev.some(t => t.id === id)
        ? prev.map(t => t.id === id ? updated : t)
        : [updated, ...prev].sort((a, b) =>
            new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
          )
    );
  }, []);

  const { markSelfWrite } = useVaultWatcher(
    {
      vaultPath,
      enabled: !!vaultPath,
    },
    {
      onConversationAdded: handleConversationAdded,
      onConversationRemoved: handleConversationRemoved,
      onConversationModified: handleConversationModified,
      onConfigChanged: handleConfigChanged,
      onNoteAdded: handleNoteChanged,
      onNoteRemoved: handleNoteChanged,
      onNoteModified: handleNoteModified,
      onTaskAdded: handleTaskAdded,
      onTaskRemoved: handleTaskRemoved,
      onTaskModified: handleTaskModified,
    }
  );

  // Where "Edit" actions open vault files (Obsidian for markdown, else system).
  const externalEditor: ExternalEditor = config?.externalEditor ?? 'obsidian';

  // Open a note for editing in the configured external editor.
  const handleEditNote = useCallback(async (filename: string) => {
    const path = await vaultService.getNoteFilePath(filename);
    if (path) await openInEditor(path, config?.externalEditor ?? 'obsidian');
  }, [config?.externalEditor]);

  // Persist an AI-assisted note edit and refresh the in-app view. markSelfWrite
  // suppresses the watcher's own reload so we control the update.
  const handleSaveNoteEdit = useCallback(async (filename: string, content: string) => {
    const absPath = await vaultService.getNoteFilePath(filename);
    if (absPath) markSelfWrite(absPath);
    await vaultService.writeNote(filename, content);
    setNoteContent(content);
    const loadedNotes = await vaultService.loadNotes();
    setNotes(loadedNotes);
    if (filename === 'memory.md') {
      const loadedMemory = await vaultService.loadMemory();
      setMemory(loadedMemory);
    }
  }, [markSelfWrite]);

  // Persist the external-editor preference (comment-preserving), optimistic.
  const handleSetExternalEditor = useCallback(async (value: ExternalEditor) => {
    const prev = config?.externalEditor;
    setConfig(c => c ? { ...c, externalEditor: value } : c);
    try {
      const vaultPathForSave = vaultService.getVaultPath();
      if (vaultPathForSave) markSelfWrite(`${vaultPathForSave}/config.yaml`);
      await vaultService.updateConfigValue('externalEditor', value);
    } catch (e) {
      console.error('Failed to persist externalEditor:', e);
      setConfig(c => c ? { ...c, externalEditor: prev } : c);
    }
  }, [config?.externalEditor, markSelfWrite]);

  // Extracted hook: handles message sending, streaming, saving, error recovery
  const { handleSendMessage, handleSaveImage, handleLoadImageAsBase64, handleCompactNow } = useSendMessage({
    config, memory, markSelfWrite, showToast, chatInterfaceRef,
    setDraftConversation, setConversations,
    setStreamingThinkingState, updateStreamingThinking, finishStreamingThinking,
    addToolUse, startSubagents, updateSubagentContent, addSubagentToolUse, completeSubagent,
  });

  useEffect(() => {
    const initializeApp = async () => {
      try {
        const savedVaultPath = localStorage.getItem('vaultPath');

        // Phase 2: inside Tauri, ask the embedded server for its URL and
        // bind it to the saved vault path BEFORE any HTTP calls happen.
        // First launch: server has no URL yet; once the user picks a vault
        // via the setup screen, setEmbeddedVaultPath bootstraps the server.
        if (isTauri()) {
          if (savedVaultPath) {
            await setEmbeddedVaultPath(savedVaultPath);
          } else {
            await loadEmbeddedServerUrl();
          }
        }

        if (savedVaultPath) {
          await loadVault(savedVaultPath);
        } else if (!isTauri()) {
          // Browser hitting alloy-serve: server has its own VAULT_PATH from
          // --vault flag; just load it.
          await loadVault('/');
        } else {
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error initializing app:', error);
        if (isBackendUnreachable(error)) {
          // /api fetch failed (likely ECONNREFUSED via vite proxy because the
          // embedded server isn't on :3001). Don't clear vaultPath — the user
          // didn't pick a bad vault, the backend is just down.
          setInitError(
            'Could not reach the Alloy backend. If this is a dev session, make sure `tauri dev` is running; ' +
            'if you opened the app from another device via Tailscale, the desktop needs "Share on Network" enabled.'
          );
        } else {
          localStorage.removeItem('vaultPath');
        }
        setIsLoading(false);
      }
    };

    initializeApp();
  }, []);

  // Re-check model discovery while the app is active. This matters most for
  // LAN providers (oMLX/Ollama): the provider may have been unreachable at
  // startup and become available after a Wi-Fi/network change. The backend
  // caches complete discovery for an hour, but deliberately leaves partial
  // results uncached, so an unavailable provider is retried on these checks.
  useEffect(() => {
    if (!config) return;

    let disposed = false;
    let inFlight = false;
    const refreshModels = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const discovered = await fetchAvailableModelList();
        if (!disposed) {
          setAvailableModels(current => modelListsMatch(current, discovered) ? current : discovered);
        }
      } catch (error) {
        console.warn('[App] periodic /api/models fetch failed (non-fatal):', error);
      } finally {
        inFlight = false;
      }
    };

    const interval = window.setInterval(refreshModels, 5 * 60 * 1000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshModels();
    };
    const onFocus = () => void refreshModels();
    const onOnline = () => void refreshModels();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [config]);

  // Build unified timeline whenever data changes
  useEffect(() => {
    setTimelineItems(vaultService.buildTimeline(conversations, notes, tasks));
  }, [conversations, notes, tasks]);

  // Compute selected item ID for sidebar highlighting
  const selectedItemId = selectedItem?.id ?? null;

  // Handle selecting an item from the timeline
  const handleSelectItem = useCallback(async (item: TimelineItem) => {
    // Navigate to the selected item
    if (item.type === 'riff') {
      navigateTo({ type: 'note', id: item.id });
    } else if (item.type === 'note') {
      navigateTo({ type: 'note', id: item.id });
    } else if (item.type === 'conversation') {
      (window as { __chatClickAt?: { id: string; t: number } }).__chatClickAt = { id: item.id, t: performance.now() };
      console.debug('[perf] click conversation', item.id);
      navigateTo({ type: 'conversation', id: item.id });
      // Focus input after selection
      setTimeout(() => {
        chatInterfaceRef.current?.focusInput();
      }, 0);
    } else if (item.type === 'task') {
      navigateTo({ type: 'task', id: item.id });
    }

    // Clear draft conversation when switching away from it
    setDraftConversation(null);

    if (item.type === 'conversation') {
      // Mark as read when user selects the conversation
      markAsRead(item.id);
    } else if (item.type === 'note' || item.type === 'riff') {
      // Load note content
      try {
        setNoteContent(await vaultService.readNote(item.id));
      } catch (error) {
        console.error('[App] Failed to load note:', error);
        setNoteContent(null);
      }
    }
    // For tasks, no additional loading needed - derived from tasks list
  }, [markAsRead, navigateTo]);

  // Handle deleting a note
  const handleDeleteNote = useCallback(async (filename: string) => {
    await vaultService.deleteNote(filename);
    // If this is the selected note, clear the selection
    if (selectedItem?.type === 'note' && selectedItem.id === filename) {
      setSelectedItem(null);
    }
    setNoteContent(null);
    // Reload notes list
    const loadedNotes = await vaultService.loadNotes();
    setNotes(loadedNotes);
  }, [selectedItem]);

  const loadVault = async (path: string) => {
    try {
      // Phase 2: in Tauri, the embedded server needs to know the vault
      // path before any /api/fs/* calls happen. setEmbeddedVaultPath spins
      // up (or rebinds) the axum listener and updates the API base URL.
      // No-op outside Tauri (standalone alloy-serve already knows its vault).
      if (isTauri()) {
        await setEmbeddedVaultPath(path);
      }

      vaultService.setVaultPath(path);
      // Ensure vault structure exists (creates missing dirs/skills)
      await vaultService.initializeVault(path);
      const loadedConfig = await vaultService.loadConfig();

      if (loadedConfig) {
        setConfig(loadedConfig);
        localStorage.setItem('vaultPath', path);

        // Pull the live model list from the embedded alloy-server. This is
        // the only source of truth for available models in the all-server
        // architecture; the SPA no longer bundles per-provider lists.
        let loadedModels: ModelInfo[] = [];
        try {
          loadedModels = await fetchAvailableModelList();
        } catch (e) {
          console.warn('[App] /api/models fetch failed (non-fatal):', e);
        }
        setAvailableModels(loadedModels);

        // Warn loudly when defaultModel can't be honored. Without this the SPA
        // silently substitutes availableModels[0] in `getDefaultModel`.
        if (
          loadedConfig.defaultModel &&
          loadedModels.length > 0 &&
          !loadedModels.some(m => m.key === loadedConfig.defaultModel)
        ) {
          showToast(
            `defaultModel "${loadedConfig.defaultModel}" isn't available — edit config.yaml or pick another model.`,
            'error',
          );
        }

        // Load all vault data in parallel
        skillRegistry.setVaultPath(path);
        riffService.setVaultPath(path);

        const [loadedConversations, loadedTasks, loadedNotes, , loadedMemory] = await Promise.all([
          // Metadata-only summaries (one batched header read); message bodies are
          // loaded lazily when a conversation is opened.
          vaultService.loadConversationSummaries(),
          vaultService.loadTasks(),
          vaultService.loadNotes(),
          skillRegistry.loadSkills(),
          vaultService.loadMemory(),
        ]);

        setConversations(loadedConversations);
        setTasks(loadedTasks);
        setNotes(loadedNotes);
        setMemory(loadedMemory);

        // Reconnect to any in-flight streaming sessions.
        reconnectToActiveSessions({
          startStreaming,
          updateStreamingContent,
          setStreamingThinkingState,
          updateStreamingThinking,
          finishStreamingThinking,
          completeStreaming,
          stopStreaming,
        }).catch(e => console.error('Failed to reconnect to active streams:', e));
      } else {
        localStorage.removeItem('vaultPath');
      }
    } catch (error) {
      console.error('Error loading vault:', error);
      if (isBackendUnreachable(error)) {
        setInitError(
          'Could not reach the Alloy backend. If this is a dev session, make sure `tauri dev` is running; ' +
          'if you opened the app from another device via Tailscale, the desktop needs "Share on Network" enabled.'
        );
      } else {
        localStorage.removeItem('vaultPath');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Set the ref so handleConfigChanged can call loadVault
  loadVaultRef.current = loadVault;

  const handleVaultSelected = async (path: string, provider: ProviderType, credential: string) => {
    // Default models for each provider (using provider/model format)
    const defaultModels: Record<ProviderType, string> = {
      anthropic: 'anthropic/claude-sonnet-4-6',
      openai: 'openai/gpt-5.4-mini',
      gemini: 'gemini/gemini-3.5-flash',
      grok: 'grok/grok-4.3',
      openrouter: 'openrouter/anthropic/claude-sonnet-4.5',
      ollama: '', // Ollama models are discovered dynamically
      mlx: '', // Local MLX (oMLX) models are discovered dynamically
      'claude-cli': 'claude-cli/sonnet', // not selectable in setup; config-only
    };

    // Build config YAML with the active provider uncommented and others commented out
    const providerLines: Record<string, { key: string; placeholder: string }> = {
      anthropic: { key: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
      openai: { key: 'OPENAI_API_KEY', placeholder: 'sk-...' },
      gemini: { key: 'GEMINI_API_KEY', placeholder: '...' },
      grok: { key: 'XAI_API_KEY', placeholder: 'xai-...' },
      openrouter: { key: 'OPENROUTER_API_KEY', placeholder: 'sk-or-v1-...' },
      ollama: { key: 'OLLAMA_BASE_URL', placeholder: 'http://localhost:11434' },
    };

    const lines = [`defaultModel: ${defaultModels[provider]}`, ''];
    for (const [p, info] of Object.entries(providerLines)) {
      if (p === provider) {
        lines.push(`${info.key}: ${credential}`);
      } else {
        lines.push(`# ${info.key}: ${info.placeholder}`);
      }
    }
    lines.push('', '# API keys for skills', '# SERPER_API_KEY: ...', '');

    vaultService.setVaultPath(path);
    await vaultService.saveRawConfig(lines.join('\n'));
    await loadVault(path);
  };

  // Helper to get a default model for new conversations. Only returns a key
  // that actually exists in availableModels, so the picker always shows a
  // selected model rather than falling back to "Select Model".
  const getDefaultModel = (): string | null => {
    const validKeys = new Set(availableModels.map(m => m.key));
    const isValid = (key: string | undefined | null): key is string =>
      !!key && validKeys.has(key);

    const liveFavorites = (config?.favoriteModels ?? []).filter(isValid);
    if (liveFavorites.length > 0) {
      return liveFavorites[Math.floor(Math.random() * liveFavorites.length)];
    }

    if (isValid(config?.defaultModel)) return config!.defaultModel;
    return availableModels[0]?.key ?? null;
  };

  const handleNewConversation = () => {
    const model = getDefaultModel();
    if (!model) {
      showToast('No provider configured. Please add a provider in Settings.', 'error');
      return;
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);

    const newConversation: Conversation = {
      id: `${date}-${time}-${hash}`,
      created: now.toISOString(),
      updated: now.toISOString(),
      model: model,
      messages: [],
    };
    // Store as draft until first message is sent
    setDraftConversation(newConversation);
    setNoteContent(null);
    navigateTo({ type: 'conversation', id: newConversation.id });
    // Focus input after creation
    setTimeout(() => {
      chatInterfaceRef.current?.focusInput();
    }, 0);
  };

  // Keyboard shortcuts (Cmd+N, Cmd+,, Cmd+F, Escape)
  useKeyboardShortcuts({
    showSettings, showFind, selectedItem,
    onNewConversation: handleNewConversation,
    setShowSettings, setShowFind,
    setSelectedItem, setNoteContent,
    sidebarRef, findRef,
  });

  // Keep the main pane useful without a separate landing mode: desktop starts a
  // transient draft when nothing is selected; mobile does so on entering chat.
  useEffect(() => {
    if ((!isMobile || mobileView === 'conversation') && !selectedItem && !riffContext.isRiffMode && config && availableModels.length > 0) {
      handleNewConversation();
    }
  }, [isMobile, mobileView, selectedItem, riffContext.isRiffMode, config, availableModels.length]);

  const handleSelectNote = async (filename: string) => {
    if (!vaultService.getVaultPath()) return;
    // Don't navigate to the same note we're already viewing
    if (selectedItem?.type === 'note' && selectedItem.id === filename) {
      return;
    }

    try {
      const content = await vaultService.readNote(filename);
      if (content === null) {
        const displayName = filename.replace(/\.md$/, '');
        showToast(`Note "${displayName}" doesn't exist`, 'warning');
        return;
      }
      // Clear draft conversation and select note
      setDraftConversation(null);
      navigateTo({ type: 'note', id: filename });
      setNoteContent(content);
    } catch (error) {
      console.error('[App] Failed to load note:', error);
      showToast(`Failed to load note`, 'error');
    }
  };

  const handleToggleFavorite = useCallback(async (modelKey: string) => {
    const current = config?.favoriteModels ?? [];
    const next = current.includes(modelKey)
      ? current.filter(k => k !== modelKey)
      : [...current, modelKey];
    setConfig(prev => prev ? { ...prev, favoriteModels: next } : prev);
    try {
      const vaultPathForSave = vaultService.getVaultPath();
      if (vaultPathForSave) markSelfWrite(`${vaultPathForSave}/config.yaml`);
      await vaultService.updateFavoriteModels(next);
    } catch (e) {
      console.error('Failed to persist favorites:', e);
      // Roll back state on persist failure so UI matches disk.
      setConfig(prev => prev ? { ...prev, favoriteModels: current } : prev);
    }
  }, [config, markSelfWrite]);

  const handleModelChange = (modelKey: string) => {
    if (!currentConversation) return;

    const modelChanged = modelKey !== currentConversation.model;

    if (modelChanged) {
      const logMessage: Message = {
        role: 'log',
        timestamp: new Date().toISOString(),
        content: `Switched to ${modelKey}`,
      };
      const updatedConversation: Conversation = {
        ...currentConversation,
        model: modelKey,
        messages: [...currentConversation.messages, logMessage],
      };
      // Update draft or conversation in list
      setDraftConversation(prev => prev?.id === updatedConversation.id ? updatedConversation : prev);
      setConversations(prev => prev.map(c => c.id === updatedConversation.id ? updatedConversation : c));
    }
  };

  // handleSendMessage wrapper: ChatInterface calls with (content, attachments, onChunk, signal)
  // but useSendMessage needs currentConversation as first arg
  const handleSendMessageForChat = useCallback(async (content: string, attachments: Attachment[], onChunk?: (text: string) => void, signal?: AbortSignal): Promise<void> => {
    if (!currentConversation) return;
    await handleSendMessage(currentConversation, content, attachments, onChunk, signal);
  }, [currentConversation, handleSendMessage]);

  const handleSelectConversation = async (id: string, _addToHistory = true, messageId?: string) => {
    // Store messageId for scrolling after conversation loads
    setPendingScrollToMessageId(messageId || null);

    // Don't navigate to the same conversation we're already viewing
    if (currentConversation?.id === id && !selectedNote) {
      return;
    }

    // Mark as read when user selects the conversation
    markAsRead(id);

    // Clear other selections
    setNoteContent(null);
    setDraftConversation(null);
    navigateTo({ type: 'conversation', id });

    // Focus input after selection
    setTimeout(() => {
      chatInterfaceRef.current?.focusInput();
    }, 0);
  };

  const handleRenameConversation = async (oldId: string, newTitle: string) => {
    try {
      // Find the old file path and mark it for self-write
      const vaultPathForRename = vaultService.getVaultPath();
      if (vaultPathForRename) {
        const oldFilePath = await vaultService.getConversationFilePath(oldId);
        if (oldFilePath) {
          markSelfWrite(oldFilePath);
          // Also mark the old .md file
          markSelfWrite(oldFilePath.replace(/\.yaml$/, '.md'));
        }
        // Mark the new file path that will be created
        const newFilename = vaultService.generateFilename(oldId, newTitle);
        const newFilePath = `${vaultPathForRename}/conversations/${newFilename}`;
        markSelfWrite(newFilePath);
        markSelfWrite(newFilePath.replace(/\.yaml$/, '.md'));
      }
      const updatedConversation = await vaultService.renameConversation(oldId, newTitle);
      if (updatedConversation) {
        setConversations((prev) =>
          prev.map((c) => (c.id === oldId ? updatedConversation : c))
        );
        // Also update draft if it's the renamed conversation
        setDraftConversation(prev => prev?.id === oldId ? updatedConversation : prev);
      }
    } catch (error) {
      console.error('Error renaming conversation:', error);
      showToast('Failed to rename conversation. Please try again.', 'error');
    }
  };

  const handleRenameRiff = async (oldFilename: string, newName: string) => {
    try {
      const vaultPathForRename = vaultService.getVaultPath();
      if (vaultPathForRename) {
        // Mark old file for self-write
        markSelfWrite(`${vaultPathForRename}/${oldFilename}`);
        // Mark new file path
        const sanitizedName = newName.replace(/\.md$/, '').replace(/[/\\:*?"<>|]/g, '-').trim();
        markSelfWrite(`${vaultPathForRename}/riffs/${sanitizedName}.md`);
      }

      const newFilename = await vaultService.renameRiff(oldFilename, newName);
      if (newFilename) {
        // Reload notes to get updated list
        const updatedNotes = await vaultService.loadNotes();
        setNotes(updatedNotes);

        // Update selection if this riff was selected
        if (selectedItem?.type === 'note' && selectedItem.id === oldFilename) {
          setSelectedItem({ type: 'note', id: newFilename });
        }
      }
    } catch (error) {
      console.error('Error renaming riff:', error);
      showToast('Failed to rename riff. Please try again.', 'error');
    }
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      // Stop streaming if this conversation is streaming
      stopStreaming(id);

      // Mark as self-write to avoid watcher triggering on our own delete
      const vaultPathForDelete = vaultService.getVaultPath();
      if (vaultPathForDelete) {
        const filePath = await vaultService.getConversationFilePath(id);
        if (filePath) {
          markSelfWrite(filePath);
          markSelfWrite(filePath.replace(/\.yaml$/, '.md'));
        }
      }
      const deleted = await vaultService.deleteConversation(id);
      if (deleted) {
        setConversations((prev) => prev.filter((c) => c.id !== id));
        setDraftConversation(prev => prev?.id === id ? null : prev);

        if (selectedItem?.type === 'conversation' && selectedItem.id === id) {
          setSelectedItem(null);
        }
      }
    } catch (error) {
      console.error('Error deleting conversation:', error);
      showToast('Failed to delete conversation. Please try again.', 'error');
    }
  };


  if (isLoading) {
    return <div className="loading">Loading...</div>;
  }

  if (initError) {
    return (
      <div className="loading" style={{ flexDirection: 'column', gap: 16, padding: 32, textAlign: 'center' }}>
        <div style={{ fontWeight: 600 }}>Backend unreachable</div>
        <div style={{ maxWidth: 480, opacity: 0.85 }}>{initError}</div>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  if (!config) {
    return (
      <>
        <VaultSetup
          onVaultSelected={handleVaultSelected}
          onExistingVault={loadVault}
          onError={(msg) => showToast(msg, 'error')}
        />
        <ToastContainer messages={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  // Handle deleting a task
  const handleDeleteTask = async (taskId: string) => {
    try {
      const vaultPathForDelete = vaultService.getVaultPath();
      if (vaultPathForDelete) {
        const filePath = await vaultService.getTaskFilePath(taskId);
        if (filePath) markSelfWrite(filePath);
      }
      await vaultService.deleteTask(taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (error) {
      console.error('Error deleting task:', error);
    }
  };

  // Handle "Ask about this" from task detail view - creates a spinoff conversation
  const handleAskAboutTask = async (task: ScheduledTask) => {
    // Get the latest triggered response (most recent assistant message)
    const latestResponse = task.messages
      ?.filter(m => m.role === 'assistant')
      .pop();

    if (!latestResponse) {
      console.warn('No response to ask about');
      return;
    }

    // Create a new conversation with the task response as context
    // Use standard ID format (YYYY-MM-DD-HHMM-hash) to match vault watcher expectations
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);
    const newId = `${date}-${time}-${hash}`;
    const nowISO = now.toISOString();
    const defaultModel = getDefaultModel() || task.model;

    const newConversation: Conversation = {
      id: newId,
      created: nowISO,
      updated: nowISO,
      model: defaultModel,
      title: `Re: ${task.title || 'Task'}`,
      messages: [
        {
          role: 'user',
          content: `Context from scheduled task "${task.title}":\n\n${latestResponse.content}`,
          timestamp: nowISO,
        },
      ],
    };

    // Mark self-write to prevent vault watcher from creating a duplicate
    const vaultPathForSave = vaultService.getVaultPath();
    if (vaultPathForSave) {
      const filename = vaultService.generateFilename(newConversation.id, newConversation.title);
      markSelfWrite(`${vaultPathForSave}/conversations/${filename}`);
    }

    // Save the new conversation
    await vaultService.saveConversation(newConversation);

    // Update state
    setConversations(prev => [newConversation, ...prev]);
    setDraftConversation(null);
    navigateTo({ type: 'conversation', id: newConversation.id });
  };


  return (
    <TaskProvider tasks={tasks}>
        <UpdateChecker />
        {memory && (
          <MemoryWarning
            sizeBytes={memory.sizeBytes}
            onEdit={() => handleSelectNote('memory.md')}
          />
        )}
        {riffContext.phase === 'approving' && (
          <RiffBatchApprovalModal
            proposedChanges={riffContext.proposedChanges}
            isProcessing={riffContext.isProcessing}
            onApply={riffContext.applyChanges}
            onCancel={riffContext.cancelIntegration}
          />
        )}
        <div className="app">
        {isMobile ? (
          // Mobile layout - show one view at a time
          mobileView === 'list' ? (
            <Sidebar
              ref={sidebarRef}
              fullScreen
              onMobileBack={() => setMobileView('conversation')}
              onNewRiff={handleNewRiff}
              timelineItems={timelineItems}
              activeFilter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedItemId={selectedItemId}
              onSelectItem={async (item) => {
                await handleSelectItem(item);
                setMobileView('conversation');
              }}
              streamingConversationIds={getStreamingConversationIds()}
              unreadConversationIds={getUnreadConversationIds()}
              availableModels={availableModels}
              externalEditor={externalEditor}
              onNewConversation={() => {
                handleNewConversation();
                setMobileView('conversation');
              }}
              onRenameConversation={handleRenameConversation}
              onRenameRiff={handleRenameRiff}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTask={handleDeleteTask}
              onDeleteNote={handleDeleteNote}
            />
          ) : (
          <div className="main-panel" ref={mainPanelRef}>
            {showFind && (
              <FindInConversation
                ref={findRef}
                containerRef={mainPanelRef}
                onClose={() => setShowFind(false)}
              />
            )}
            {selectedItem?.type === 'task' && selectedTask ? (
              // Mobile: viewing a task
              <React.Suspense fallback={<div className="loading">Loading task…</div>}>
                <TaskDetailView
                  key={selectedTask.id}
                  task={selectedTask}
                  availableModels={availableModels}
                  favoriteModels={config?.favoriteModels}
                  onToggleFavorite={handleToggleFavorite}
                  defaultModel={config?.defaultModel}
                  onBack={() => setMobileView('list')}
                  canGoBack={true}
                  onDelete={async () => {
                    await handleDeleteTask(selectedTask.id);
                    setSelectedItem(null);
                    setMobileView('list');
                  }}
                  onRunComplete={async () => {
                    const refreshed = await vaultService.loadTask(selectedTask.id);
                    if (refreshed) {
                      setTasks(prev => prev.map(t => t.id === refreshed.id ? refreshed : t));
                    }
                  }}
                  onAskAbout={handleAskAboutTask}
                  onTaskUpdated={(updated) => {
                    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
                  }}
                />
              </React.Suspense>
            ) : selectedItem?.type === 'note' ? (
              // Mobile: viewing a note or draft
              isViewingDraft ? (
                <RiffView
                  notes={notes}
                  model={config?.defaultModel || availableModels[0]?.key || ''}
                  sonioxApiKey={config?.SONIOX_API_KEY}
                  onNavigateToNote={handleSelectNote}
                  onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                  conversations={conversations}
                  onBack={() => setMobileView('list')}
                  canGoBack={true}
                />
              ) : selectedNote ? (
                <NoteViewer
                  key={selectedNote.filename}
                  content={selectedNote.content}
                  filename={selectedNote.filename}
                  onNavigateToNote={handleSelectNote}
                  onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                  onIntegrate={() => handleIntegrateNote(selectedNote.filename)}
                  onEdit={handleEditNote}
                  onSaveNote={handleSaveNoteEdit}
                  availableModels={availableModels}
                  favoriteModels={config?.favoriteModels}
                  onToggleFavorite={handleToggleFavorite}
                  defaultModel={config?.defaultModel}
                  conversations={conversations}
                  onBack={() => setMobileView('list')}
                  canGoBack={true}
                />
              ) : (
                // Loading state while note content loads
                <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <span>Loading...</span>
                </div>
              )
            ) : riffContext.isRiffMode && !selectedItem ? (
              // Mobile: fresh riff mode (no item selected)
              <RiffView
                notes={notes}
                model={config?.defaultModel || availableModels[0]?.key || ''}
                sonioxApiKey={config?.SONIOX_API_KEY}
                onNavigateToNote={handleSelectNote}
                onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                conversations={conversations}
                onBack={() => setMobileView('list')}
                canGoBack={true}
              />
            ) : (
              // Mobile: conversation view
              <ChatInterface
                ref={chatInterfaceRef}
                conversation={currentConversation}
                onSendMessage={handleSendMessageForChat}
                onSaveImage={handleSaveImage}
                loadImageAsBase64={handleLoadImageAsBase64}
                onCompactNow={async () => { if (currentConversation) await handleCompactNow(currentConversation); }}
                hasProvider={availableModels.length > 0}
                onModelChange={handleModelChange}
                availableModels={availableModels}
                favoriteModels={config?.favoriteModels}
                onToggleFavorite={handleToggleFavorite}
                defaultModel={config?.defaultModel}
                onNavigateToNote={handleSelectNote}
                onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                scrollToMessageId={pendingScrollToMessageId}
                onScrollComplete={() => setPendingScrollToMessageId(null)}
                onMobileBack={() => setMobileView('list')}
              />
            )}
          </div>
          )
        ) : (
          // Desktop layout - sidebar + main panel
          <>
            <Sidebar
              ref={sidebarRef}
              onNewRiff={handleNewRiff}
              timelineItems={timelineItems}
              activeFilter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedItemId={selectedItemId}
              onSelectItem={handleSelectItem}
              streamingConversationIds={getStreamingConversationIds()}
              unreadConversationIds={getUnreadConversationIds()}
              availableModels={availableModels}
              externalEditor={externalEditor}
              onNewConversation={handleNewConversation}
              onRenameConversation={handleRenameConversation}
              onRenameRiff={handleRenameRiff}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTask={handleDeleteTask}
              onDeleteNote={handleDeleteNote}
            />
      <div className="main-panel" ref={mainPanelRef}>
        {showFind && (
          <FindInConversation
            ref={findRef}
            containerRef={mainPanelRef}
            onClose={() => setShowFind(false)}
          />
        )}
        {isRiffNote || (riffContext.isRiffMode && !hasNonRiffSelection) ? (
          <RiffView
            notes={notes}
            model={config?.defaultModel || availableModels[0]?.key || ''}
            sonioxApiKey={config?.SONIOX_API_KEY}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            conversations={conversations}
            onBack={goBack}
            canGoBack={canGoBack}
          />
        ) : selectedTask ? (
          <React.Suspense fallback={<div className="loading">Loading task…</div>}>
            <TaskDetailView
              key={selectedTask.id}
              task={selectedTask}
              availableModels={availableModels}
              favoriteModels={config?.favoriteModels}
              onToggleFavorite={handleToggleFavorite}
              defaultModel={config?.defaultModel}
              onBack={goBack}
              canGoBack={canGoBack}
              onDelete={async () => {
                await handleDeleteTask(selectedTask.id);
                setSelectedItem(null);
              }}
              onRunComplete={async () => {
                const refreshed = await vaultService.loadTask(selectedTask.id);
                if (refreshed) {
                  setTasks(prev => prev.map(t => t.id === refreshed.id ? refreshed : t));
                }
              }}
              onAskAbout={handleAskAboutTask}
              onTaskUpdated={(updated) => {
                setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
              }}
            />
          </React.Suspense>
        ) : selectedNote ? (
          <NoteViewer
            key={selectedNote.filename}
            content={selectedNote.content}
            filename={selectedNote.filename}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            onIntegrate={() => handleIntegrateNote(selectedNote.filename)}
            onEdit={handleEditNote}
            onSaveNote={handleSaveNoteEdit}
            availableModels={availableModels}
            favoriteModels={config?.favoriteModels}
            onToggleFavorite={handleToggleFavorite}
            defaultModel={config?.defaultModel}
            conversations={conversations}
            onBack={goBack}
            canGoBack={canGoBack}
          />
        ) : (
          <ChatInterface
            ref={chatInterfaceRef}
            conversation={currentConversation}
            onSendMessage={handleSendMessageForChat}
            onSaveImage={handleSaveImage}
            loadImageAsBase64={handleLoadImageAsBase64}
            onCompactNow={async () => { if (currentConversation) await handleCompactNow(currentConversation); }}
            hasProvider={availableModels.length > 0}
            onModelChange={handleModelChange}
            availableModels={availableModels}
            favoriteModels={config?.favoriteModels}
            onToggleFavorite={handleToggleFavorite}
            defaultModel={config?.defaultModel}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            scrollToMessageId={pendingScrollToMessageId}
            onScrollComplete={() => setPendingScrollToMessageId(null)}
            onBack={goBack}
            canGoBack={canGoBack}
          />
        )}
      </div>
          </>
        )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          vaultPath={vaultPath}
          externalEditor={externalEditor}
          onExternalEditorChange={handleSetExternalEditor}
        />
      )}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      </div>
    </TaskProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <StreamingProvider>
        <MessageQueueProvider>
          <RiffProvider>
            <ContextMenuProvider>
              <AppContent />
              <ContextMenu />
            </ContextMenuProvider>
          </RiffProvider>
        </MessageQueueProvider>
      </StreamingProvider>
    </ErrorBoundary>
  );
}

export default App;
