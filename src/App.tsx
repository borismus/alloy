import React, { useState, useEffect, useRef, useCallback } from 'react';
import { vaultService } from './services/vault';
import { providerRegistry } from './services/providers';
import { skillRegistry } from './services/skills';
import { riffService } from './services/riff';
import { useVaultWatcher } from './hooks/useVaultWatcher';
import { useIsMobile } from './hooks/useIsMobile';
import { useVisualViewport } from './hooks/useVisualViewport';
import { useStreamingContext, StreamingProvider } from './contexts/StreamingContext';
import { TriggerProvider } from './contexts/TriggerContext';
import { ApprovalProvider } from './contexts/ApprovalContext';
import { Conversation, Config, Message, ProviderType, ModelInfo, Attachment, formatModelId, NoteInfo, TimelineFilter, TimelineItem, Trigger, SelectedItem } from './types';
import { useSendMessage } from './hooks/useSendMessage';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { Sidebar, SidebarHandle } from './components/Sidebar';
import { Settings } from './components/Settings';
import { TriggerDetailView } from './components/TriggerDetailView';
import { NoteViewer } from './components/NoteViewer';
import { FindInConversation, FindInConversationHandle } from './components/FindInConversation';
// MobileNewConversation removed - ChatInterface handles both new and existing conversations
import { UpdateChecker } from './components/UpdateChecker';
import { MemoryWarning } from './components/MemoryWarning';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { isServerMode } from './mocks';
import { reconnectToActiveSessions } from './services/server-streaming';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { RiffProvider, useRiffContext } from './contexts/RiffContext';
import { BackgroundProvider } from './contexts/BackgroundContext';
import { RiffBatchApprovalModal } from './components/RiffBatchApprovalModal';
import { RiffView } from './components/RiffView';
import { BackgroundView } from './components/BackgroundView';
import { isBackgroundConversation } from './services/background';
import { ContextMenu } from './components/ContextMenu';
import { ToastContainer, ToastMessage } from './components/Toast';
import './App.css';

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


function AppContent() {
  useVisualViewport();
  const [config, setConfig] = useState<Config | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);

  // Selected item and navigation history
  const [selectedItem, setSelectedItemRaw] = useState<SelectedItem>(() => {
    try {
      const saved = sessionStorage.getItem('selectedItem');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const setSelectedItem = useCallback((item: SelectedItem) => {
    setSelectedItemRaw(item);
    try {
      if (item) sessionStorage.setItem('selectedItem', JSON.stringify(item));
      else sessionStorage.removeItem('selectedItem');
    } catch { /* ignore */ }
  }, []);
  const [previousItem, setPreviousItem] = useState<SelectedItem>(null);

  // Navigate to a new item, saving current as previous (for back button)
  const navigateTo = useCallback((item: SelectedItem) => {
    if (selectedItem) {
      setPreviousItem(selectedItem);
    }
    setSelectedItem(item);
  }, [selectedItem]);

  // Go back to previous item
  const goBack = useCallback(async () => {
    if (!previousItem) return;

    // If going back to a note, we need to load its content
    if (previousItem.type === 'note') {
      const filename = previousItem.id;
      const vaultPathStr = vaultService.getVaultPath();
      const notesPath = vaultService.getNotesPath();
      if (vaultPathStr && notesPath) {
        const notePath = filename === 'memory.md' || filename.startsWith('riffs/')
          ? `${vaultPathStr}/${filename}`
          : `${notesPath}/${filename}`;
        try {
          const content = await readTextFile(notePath);
          setNoteContent(content);
        } catch (error) {
          console.error('[App] Failed to load note on back:', error);
        }
      }
    } else {
      setNoteContent(null);
    }

    setSelectedItem(previousItem);
    setPreviousItem(null);
    setDraftConversation(null);
  }, [previousItem]);

  const canGoBack = previousItem !== null;

  // Cached note content (loaded on demand when note is selected)
  const [noteContent, setNoteContent] = useState<string | null>(null);
  // Transient conversation state for new/unsaved conversations
  const [draftConversation, setDraftConversation] = useState<Conversation | null>(null);
  // Memory content and size for system prompt injection
  const [memory, setMemory] = useState<{ content: string; sizeBytes: number } | null>(null);
  // Background conversation (persistent, always-available command interface)
  const [backgroundConversation, setBackgroundConversation] = useState<Conversation | null>(null);
  // Toast notifications
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}`;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Derive selected items from lists based on selectedItem
  const currentConversation = selectedItem?.type === 'conversation'
    ? (draftConversation?.id === selectedItem.id ? draftConversation : conversations.find(c => c.id === selectedItem.id)) ?? null
    : null;
  const selectedTrigger = selectedItem?.type === 'trigger'
    ? triggers.find(t => t.id === selectedItem.id) ?? null
    : null;
  const selectedNote = selectedItem?.type === 'note' && noteContent !== null
    ? { filename: selectedItem.id, content: noteContent }
    : null;

  // Mobile navigation state
  const isMobile = useIsMobile();
  type MobileView = 'list' | 'conversation' | 'background';
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
  const { startStreaming, updateStreamingContent, completeStreaming, stopStreaming, getStreamingConversationIds, getUnreadConversationIds, markAsRead, addToolUse, startSubagents, updateSubagentContent, addSubagentToolUse, completeSubagent } = useStreamingContext();
  const riffContext = useRiffContext();

  // Check if selected note is a riff/draft on desktop (not integrated)
  const isRiffNote = selectedNote?.filename.startsWith('riffs/') &&
    !selectedNote.content.includes('integrated: true');

  // Determine if user has selected a non-riff item (conversation, trigger, or integrated note)
  const hasNonRiffSelection = !!(currentConversation || selectedTrigger || (selectedNote && (!selectedNote.filename.startsWith('riffs/') || selectedNote.content.includes('integrated: true'))));

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
    // Route background conversations to separate state
    if (isBackgroundConversation(id)) {
      const updated = await vaultService.loadConversation(id);
      if (updated) setBackgroundConversation(updated);
      return;
    }
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

  const handleConversationRemoved = useCallback((id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    // Clear selection if removed conversation was selected
    if (selectedItem?.type === 'conversation' && selectedItem.id === id) {
      setSelectedItem(null);
    }
    setDraftConversation(prev => prev?.id === id ? null : prev);
  }, [selectedItem]);

  const handleConversationModified = useCallback(async (id: string) => {
    // Route background conversation updates to separate state
    if (isBackgroundConversation(id)) {
      const updated = await vaultService.loadConversation(id);
      if (updated) setBackgroundConversation(updated);
      return;
    }

    const updated = await vaultService.loadConversation(id);
    if (!updated) return;

    setConversations(prev =>
      prev.map(c => c.id === id ? updated : c)
    );
    // currentConversation is derived from conversations, so no need to update separately
    // But if it's a draft conversation, update that too
    setDraftConversation(prev => prev?.id === id ? updated : prev);
  }, []);

  // Handler for trigger updates (called by TriggerContext)
  // Uses atomic update to avoid overwriting concurrent edits
  const handleTriggerUpdated = useCallback(async (updatedTrigger: Trigger) => {
    try {
      // Atomic read-modify-write: load fresh from disk, merge trigger updates, save
      const merged = await vaultService.updateTrigger(updatedTrigger.id, (fresh) => ({
        ...fresh,
        // Apply the updated timestamp if messages were added
        updated: updatedTrigger.updated,
        // Use messages from the update (trigger appends new messages)
        messages: updatedTrigger.messages,
        // Apply scheduler's runtime fields (flat structure now)
        lastChecked: updatedTrigger.lastChecked,
        lastTriggered: updatedTrigger.lastTriggered,
        history: updatedTrigger.history,
      }));

      if (merged) {
        // Update state with the merged result
        setTriggers(prev =>
          prev.map(t => t.id === merged.id ? merged : t)
            .sort((a, b) => new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime())
        );
      }
    } catch (error) {
      console.error('Error saving trigger update:', error);
    }
  }, []);

  // Getter for triggers (used by TriggerProvider)
  const getTriggers = useCallback(() => triggers, [triggers]);

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
      const vaultPathStr = vaultService.getVaultPath();
      const notesPath = vaultService.getNotesPath();
      if (vaultPathStr && notesPath) {
        // memory.md and riffs/ are at vault root, other notes are in notes/
        const notePath = filename === 'memory.md' || filename.startsWith('riffs/')
          ? `${vaultPathStr}/${filename}`
          : `${notesPath}/${filename}`;
        readTextFile(notePath).then(content => {
          setNoteContent(content);
        }).catch(error => {
          console.error('Failed to refresh note content:', error);
        });
      }
    }
  }, [selectedItem]);

  // Trigger watcher callbacks
  const handleTriggerAdded = useCallback(async (id: string) => {
    const newTrigger = await vaultService.loadTrigger(id);
    if (newTrigger) {
      setTriggers(prev => {
        // Avoid duplicates
        if (prev.some(t => t.id === id)) return prev;
        return [newTrigger, ...prev].sort((a, b) =>
          new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
        );
      });
    }
  }, []);

  const handleTriggerRemoved = useCallback((id: string) => {
    setTriggers(prev => prev.filter(t => t.id !== id));
  }, []);

  const handleTriggerModified = useCallback(async (id: string) => {
    const updated = await vaultService.loadTrigger(id);
    if (!updated) return;
    setTriggers(prev =>
      prev.map(t => t.id === id ? updated : t)
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
      onTriggerAdded: handleTriggerAdded,
      onTriggerRemoved: handleTriggerRemoved,
      onTriggerModified: handleTriggerModified,
    }
  );

  // Extracted hook: handles message sending, streaming, saving, error recovery
  const { handleSendMessage, handleSaveImage, handleLoadImageAsBase64 } = useSendMessage({
    config, memory, markSelfWrite, showToast, chatInterfaceRef,
    setDraftConversation, setConversations,
    addToolUse, startSubagents, updateSubagentContent, addSubagentToolUse, completeSubagent,
  });

  useEffect(() => {
    const initializeApp = async () => {
      try {
        const savedVaultPath = localStorage.getItem('vaultPath');
        if (savedVaultPath) {
          await loadVault(savedVaultPath);
        } else if (isServerMode()) {
          // Server mode: auto-load vault (server's VAULT_PATH is the root)
          await loadVault('/');
        } else {
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error initializing app:', error);
        localStorage.removeItem('vaultPath');
        setIsLoading(false);
      }
    };

    initializeApp();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNewConversation();
      }

      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      }

      // Cmd+Shift+F: Focus sidebar search (search all conversations)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        sidebarRef.current?.focusSearch();
        return;
      }

      // Cmd+F: Find in current view
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (showFind) {
          findRef.current?.focus();
        } else {
          setShowFind(true);
        }
      }

      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false);
        return;
      }

      // Escape with no modals open: go back to background view
      // Skip if already handled (e.g. streaming stop) or if user is in a text field
      if (e.key === 'Escape' && !showSettings && selectedItem && !e.defaultPrevented) {
        setSelectedItem(null);
        setNoteContent(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, showFind, selectedItem, config]);

  // Close find when switching views
  useEffect(() => {
    setShowFind(false);
  }, [selectedItem?.id]);

  // Build unified timeline whenever data changes
  useEffect(() => {
    setTimelineItems(vaultService.buildTimeline(conversations, notes, triggers));
  }, [conversations, notes, triggers]);

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
      navigateTo({ type: 'conversation', id: item.id });
      // Focus input after selection
      setTimeout(() => {
        chatInterfaceRef.current?.focusInput();
      }, 0);
    } else if (item.type === 'trigger') {
      navigateTo({ type: 'trigger', id: item.id });
    }

    // Clear draft conversation when switching away from it
    setDraftConversation(null);

    if (item.type === 'conversation') {
      // Mark as read when user selects the conversation
      markAsRead(item.id);
    } else if (item.type === 'note' || item.type === 'riff') {
      // Load note content
      const vaultPathStr = vaultService.getVaultPath();
      const notesPath = vaultService.getNotesPath();
      if (vaultPathStr && notesPath) {
        const notePath = item.id === 'memory.md' || item.id.startsWith('riffs/')
          ? `${vaultPathStr}/${item.id}`
          : `${notesPath}/${item.id}`;
        try {
          const content = await readTextFile(notePath);
          setNoteContent(content);
        } catch (error) {
          console.error('[App] Failed to load note:', error);
          setNoteContent(null);
        }
      }
    }
    // For triggers, no additional loading needed - derived from triggers list
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
      vaultService.setVaultPath(path);
      // Ensure vault structure exists (creates missing dirs/skills)
      await vaultService.initializeVault(path);
      const loadedConfig = await vaultService.loadConfig();

      if (loadedConfig) {
        setConfig(loadedConfig);
        localStorage.setItem('vaultPath', path);

        // Initialize providers from config
        await providerRegistry.initializeFromConfig(loadedConfig);
        setAvailableModels(providerRegistry.getAllAvailableModels());

        // Discover Ollama models in background (don't block vault loading)
        providerRegistry.discoverOllamaModels().then(() => {
          setAvailableModels(providerRegistry.getAllAvailableModels());
        });

        // Load all vault data in parallel
        skillRegistry.setVaultPath(path);
        riffService.setVaultPath(path);
        const bgDefaultModel = loadedConfig.defaultModel || providerRegistry.getAllAvailableModels()[0]?.key || '';

        const [loadedConversations, loadedTriggers, loadedNotes, , loadedMemory, bgConv] = await Promise.all([
          vaultService.loadConversations(),
          vaultService.loadTriggers(),
          vaultService.loadNotes(),
          skillRegistry.loadSkills(),
          vaultService.loadMemory(),
          vaultService.loadBackgroundConversation(bgDefaultModel),
        ]);

        setConversations(loadedConversations);
        setTriggers(loadedTriggers);
        setNotes(loadedNotes);
        setMemory(loadedMemory);
        setBackgroundConversation(bgConv);

        // In server mode, reconnect to any in-flight streaming sessions
        if (isServerMode()) {
          reconnectToActiveSessions({
            startStreaming,
            updateStreamingContent,
            completeStreaming,
            stopStreaming,
          }).catch(e => console.error('Failed to reconnect to active streams:', e));
        }
      } else {
        localStorage.removeItem('vaultPath');
      }
    } catch (error) {
      console.error('Error loading vault:', error);
      localStorage.removeItem('vaultPath');
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
      gemini: 'gemini/gemini-2.5-flash',
      grok: 'grok/grok-4-1-fast',
      ollama: '', // Ollama models are discovered dynamically
    };

    // Build config YAML with the active provider uncommented and others commented out
    const providerLines: Record<string, { key: string; placeholder: string }> = {
      anthropic: { key: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
      openai: { key: 'OPENAI_API_KEY', placeholder: 'sk-...' },
      gemini: { key: 'GEMINI_API_KEY', placeholder: '...' },
      grok: { key: 'XAI_API_KEY', placeholder: 'xai-...' },
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

  // Helper to get a default model for new conversations
  const getDefaultModel = (): string | null => {
    const favorites = config?.favoriteModels;

    if (favorites && favorites.length > 0) {
      // Pick a random favorite
      return favorites[Math.floor(Math.random() * favorites.length)];
    }

    // Fall back to default provider/model
    const defaultProvider = providerRegistry.getDefaultProvider();
    const defaultModel = providerRegistry.getDefaultModel();

    if (!defaultProvider || !defaultModel) {
      return null;
    }
    return formatModelId(defaultProvider, defaultModel);
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

  // Auto-create a new conversation when entering mobile conversation view without any selection
  useEffect(() => {
    // Only auto-create if we're in conversation view with nothing selected at all
    // (not a note, trigger, or existing conversation)
    if (isMobile && mobileView === 'conversation' && !selectedItem && config && availableModels.length > 0) {
      handleNewConversation();
    }
  }, [isMobile, mobileView, selectedItem, config, availableModels.length]);

  const handleSelectNote = async (filename: string) => {
    const vaultPathStr = vaultService.getVaultPath();
    const notesPath = vaultService.getNotesPath();
    if (vaultPathStr && notesPath) {
      // Don't navigate to the same note we're already viewing
      if (selectedItem?.type === 'note' && selectedItem.id === filename) {
        return;
      }

      // memory.md and riffs/ are at vault root, other notes are in notes/
      const notePath = filename === 'memory.md' || filename.startsWith('riffs/')
        ? `${vaultPathStr}/${filename}`
        : `${notesPath}/${filename}`;
      try {
        // Check if the note exists before trying to read it
        const noteExists = await exists(notePath);
        if (!noteExists) {
          const displayName = filename.replace(/\.md$/, '');
          showToast(`Note "${displayName}" doesn't exist`, 'warning');
          return;
        }

        const content = await readTextFile(notePath);
        // Clear draft conversation and select note
        setDraftConversation(null);
        navigateTo({ type: 'note', id: filename });
        setNoteContent(content);
      } catch (error) {
        console.error('[App] Failed to load note:', error);
        showToast(`Failed to load note`, 'error');
      }
    }
  };

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

  // Handle deleting a trigger
  const handleDeleteTrigger = async (triggerId: string) => {
    try {
      const vaultPathForDelete = vaultService.getVaultPath();
      if (vaultPathForDelete) {
        const filePath = await vaultService.getTriggerFilePath(triggerId);
        if (filePath) markSelfWrite(filePath);
      }
      await vaultService.deleteTrigger(triggerId);
      setTriggers(prev => prev.filter(t => t.id !== triggerId));
    } catch (error) {
      console.error('Error deleting trigger:', error);
    }
  };

  // Handle "Ask about this" from trigger detail view - creates a spinoff conversation
  const handleAskAboutTrigger = async (trigger: Trigger) => {
    // Get the latest triggered response (most recent assistant message)
    const latestResponse = trigger.messages
      ?.filter(m => m.role === 'assistant')
      .pop();

    if (!latestResponse) {
      console.warn('No response to ask about');
      return;
    }

    // Create a new conversation with the trigger response as context
    // Use standard ID format (YYYY-MM-DD-HHMM-hash) to match vault watcher expectations
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);
    const newId = `${date}-${time}-${hash}`;
    const nowISO = now.toISOString();
    const defaultModel = config?.defaultModel || availableModels[0]?.key || trigger.model;

    const newConversation: Conversation = {
      id: newId,
      created: nowISO,
      updated: nowISO,
      model: defaultModel,
      title: `Re: ${trigger.title || 'Trigger'}`,
      messages: [
        {
          role: 'user',
          content: `Context from monitor "${trigger.title}":\n\n${latestResponse.content}`,
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
    <TriggerProvider
      getTriggers={getTriggers}
      onTriggerUpdated={handleTriggerUpdated}
      vaultPath={vaultPath}
    >
      <BackgroundProvider
        initialConversation={backgroundConversation}
        defaultModel={config?.defaultModel || availableModels[0]?.key || ''}
        memoryContent={memory?.content}
        markSelfWrite={markSelfWrite}
      >
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
              onNewConversation={() => {
                handleNewConversation();
                setMobileView('conversation');
              }}
              onRenameConversation={handleRenameConversation}
              onRenameRiff={handleRenameRiff}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTrigger={handleDeleteTrigger}
              onDeleteNote={handleDeleteNote}
              onSelectBackground={() => {
                setMobileView('background');
              }}
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
            {selectedItem?.type === 'trigger' && selectedTrigger ? (
              // Mobile: viewing a trigger
              <TriggerDetailView
                trigger={selectedTrigger}
                onBack={() => setMobileView('list')}
                canGoBack={true}
                onDelete={async () => {
                  await handleDeleteTrigger(selectedTrigger.id);
                  setSelectedItem(null);
                  setMobileView('list');
                }}
                onRunNow={async () => {
                  const refreshed = await vaultService.loadTrigger(selectedTrigger.id);
                  if (refreshed) {
                    setTriggers(prev => prev.map(t => t.id === refreshed.id ? refreshed : t));
                  }
                }}
                onAskAbout={handleAskAboutTrigger}
                onTriggerUpdated={(updated) => {
                  setTriggers(prev => prev.map(t => t.id === updated.id ? updated : t));
                }}
              />
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
                  content={selectedNote.content}
                  filename={selectedNote.filename}
                  onNavigateToNote={handleSelectNote}
                  onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                  onIntegrate={() => handleIntegrateNote(selectedNote.filename)}
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
            ) : mobileView === 'background' ? (
              // Mobile: background mode
              <BackgroundView
                onNavigateToNote={handleSelectNote}
                onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                scrollToMessageId={pendingScrollToMessageId}
                onScrollComplete={() => setPendingScrollToMessageId(null)}
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
                hasProvider={providerRegistry.hasAnyProvider()}
                onModelChange={handleModelChange}
                availableModels={availableModels}
                favoriteModels={config?.favoriteModels}
                onNavigateToNote={handleSelectNote}
                onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                scrollToMessageId={pendingScrollToMessageId}
                onScrollComplete={() => setPendingScrollToMessageId(null)}
                onMobileBack={() => setMobileView('list')}
                onBackground={() => { setMobileView('background'); }}
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
              onNewConversation={handleNewConversation}
              onRenameConversation={handleRenameConversation}
              onRenameRiff={handleRenameRiff}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTrigger={handleDeleteTrigger}
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
            onClose={() => { setSelectedItem(null); setNoteContent(null); }}
          />
        ) : selectedTrigger ? (
          <TriggerDetailView
            trigger={selectedTrigger}
            onBack={goBack}
            canGoBack={canGoBack}
            onClose={() => { setSelectedItem(null); setNoteContent(null); }}
            onDelete={async () => {
              await handleDeleteTrigger(selectedTrigger.id);
              setSelectedItem(null);
            }}
            onRunNow={async () => {
              const refreshed = await vaultService.loadTrigger(selectedTrigger.id);
              if (refreshed) {
                setTriggers(prev => prev.map(t => t.id === refreshed.id ? refreshed : t));
              }
            }}
            onAskAbout={handleAskAboutTrigger}
            onTriggerUpdated={(updated) => {
              setTriggers(prev => prev.map(t => t.id === updated.id ? updated : t));
            }}
          />
        ) : selectedNote ? (
          <NoteViewer
            content={selectedNote.content}
            filename={selectedNote.filename}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            onIntegrate={() => handleIntegrateNote(selectedNote.filename)}
            conversations={conversations}
            onBack={goBack}
            canGoBack={canGoBack}
            onClose={() => { setSelectedItem(null); setNoteContent(null); }}
          />
        ) : currentConversation ? (
          <ChatInterface
            ref={chatInterfaceRef}
            conversation={currentConversation}
            onSendMessage={handleSendMessageForChat}
            onSaveImage={handleSaveImage}
            loadImageAsBase64={handleLoadImageAsBase64}
            hasProvider={providerRegistry.hasAnyProvider()}
            onModelChange={handleModelChange}
            availableModels={availableModels}
            favoriteModels={config?.favoriteModels}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            scrollToMessageId={pendingScrollToMessageId}
            onScrollComplete={() => setPendingScrollToMessageId(null)}
            onBack={goBack}
            canGoBack={canGoBack}
            onClose={() => { setSelectedItem(null); setNoteContent(null); }}
          />
        ) : (
          <BackgroundView
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            scrollToMessageId={pendingScrollToMessageId}
            onScrollComplete={() => setPendingScrollToMessageId(null)}
          />
        )}
      </div>
          </>
        )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          vaultPath={vaultPath}
        />
      )}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      </div>
      </BackgroundProvider>
    </TriggerProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <StreamingProvider>
        <ApprovalProvider>
          <RiffProvider>
            <ContextMenuProvider>
              <AppContent />
              <ContextMenu />
            </ContextMenuProvider>
          </RiffProvider>
        </ApprovalProvider>
      </StreamingProvider>
    </ErrorBoundary>
  );
}

export default App;
