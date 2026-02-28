import { useState, useEffect, useRef, useCallback, forwardRef } from 'react';
import { vaultService } from './services/vault';
import { providerRegistry } from './services/providers';
import { skillRegistry } from './services/skills';
import { riffService } from './services/riff';
import { triggerExecutor } from './services/triggers/executor';
import { useVaultWatcher } from './hooks/useVaultWatcher';
import { useIsMobile } from './hooks/useIsMobile';
import { useStreamingContext, StreamingProvider } from './contexts/StreamingContext';
import { TriggerProvider } from './contexts/TriggerContext';
import { ApprovalProvider } from './contexts/ApprovalContext';
import { Conversation, Config, Message, ProviderType, ModelInfo, Attachment, formatModelId, getProviderFromModel, getModelIdFromModel, NoteInfo, TimelineFilter, TimelineItem, Trigger, SelectedItem } from './types';
import { useToolExecution } from './hooks/useToolExecution';
import { estimateCost } from './services/pricing';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { Sidebar, SidebarHandle } from './components/Sidebar';
import { Settings } from './components/Settings';
import { TriggerConfigModal, TriggerFormData } from './components/TriggerConfigModal';
import { TriggerDetailView } from './components/TriggerDetailView';
import { NoteViewer } from './components/NoteViewer';
// MobileNewConversation removed - ChatInterface handles both new and existing conversations
import { UpdateChecker } from './components/UpdateChecker';
import { MemoryWarning } from './components/MemoryWarning';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { isServerMode } from './mocks';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { RiffProvider, useRiffContext } from './contexts/RiffContext';
import { BackgroundProvider } from './contexts/BackgroundContext';
import { RiffBatchApprovalModal } from './components/RiffBatchApprovalModal';
import { RiffView } from './components/RiffView';
import { BackgroundView } from './components/BackgroundView';
import { BACKGROUND_CONVERSATION_ID } from './services/background';
import { ContextMenu } from './components/ContextMenu';
import { ToastContainer, ToastMessage } from './components/Toast';
import './App.css';

// Wrapper component to access RiffContext and show approval modal
const RiffApprovalModal: React.FC = () => {
  const riffContext = useRiffContext();

  if (riffContext.phase !== 'approving') return null;

  return (
    <RiffBatchApprovalModal
      proposedChanges={riffContext.proposedChanges}
      isProcessing={riffContext.isProcessing}
      onApply={riffContext.applyChanges}
      onCancel={riffContext.cancelIntegration}
    />
  );
};

// Wrapper component for main panel that can access RiffContext
interface MainPanelWithRiffProps {
  notes: NoteInfo[];
  selectedModel: string;
  sonioxApiKey?: string;
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
  conversations: { id: string; title?: string }[];
  selectedNote: { filename: string; content: string } | null;
  hasAnySelection: boolean; // true if user selected conversation, trigger, or non-riff note
  children: React.ReactNode;
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
}

const MainPanelWithRiff: React.FC<MainPanelWithRiffProps> = ({
  notes,
  selectedModel,
  sonioxApiKey,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
  selectedNote,
  hasAnySelection,
  children,
  onBack,
  canGoBack,
  onClose,
}) => {
  const riffContext = useRiffContext();

  // Check if selected note is a riff/draft (not integrated)
  const isRiffNote = selectedNote?.filename.startsWith('riffs/') &&
    !selectedNote.content.includes('integrated: true');

  // Auto-enter riff mode when viewing a draft note
  useEffect(() => {
    if (isRiffNote && selectedNote) {
      if (!riffContext.isRiffMode || riffContext.draftFilename !== selectedNote.filename) {
        riffContext.enterRiffMode(selectedNote.filename);
      }
    }
  }, [isRiffNote, selectedNote, riffContext.isRiffMode, riffContext.draftFilename]);

  // Auto-exit riff mode when user navigates away
  useEffect(() => {
    if (riffContext.isRiffMode && hasAnySelection) {
      riffContext.exitRiffMode();
    }
  }, [hasAnySelection, riffContext]);

  // Show RiffView when viewing a draft OR in fresh riff mode (nothing selected)
  if (isRiffNote || (riffContext.isRiffMode && !hasAnySelection)) {
    return (
      <div className="main-panel">
        <RiffView
          notes={notes}
          model={selectedModel}
          sonioxApiKey={sonioxApiKey}
          onNavigateToNote={onNavigateToNote}
          onNavigateToConversation={onNavigateToConversation}
          conversations={conversations}
          onBack={onBack}
          canGoBack={canGoBack}
          onClose={onClose}
        />
      </div>
    );
  }

  return <>{children}</>;
};

// Wrapper to get onNewRiff handler for Sidebar
type SidebarWithRiffProps = Omit<React.ComponentProps<typeof Sidebar>, 'onNewRiff'> & {
  onClearSelection: () => void;
};

const SidebarWithRiff = forwardRef<SidebarHandle, SidebarWithRiffProps>(
  function SidebarWithRiff({ onClearSelection, ...props }: SidebarWithRiffProps, ref: React.Ref<SidebarHandle>) {
    const riffContext = useRiffContext();

    const handleNewRiff = useCallback(async () => {
      onClearSelection();
      await riffContext.enterRiffMode();
    }, [riffContext, onClearSelection]);

    return <Sidebar ref={ref} {...props} onNewRiff={handleNewRiff} />;
  }
);

// Effect component to auto-enter riff mode when viewing drafts on mobile
const MobileRiffModeEffect: React.FC<{
  isMobile: boolean;
  isViewingDraft: boolean;
  selectedNote: { filename: string; content: string } | null;
}> = ({ isMobile, isViewingDraft, selectedNote }) => {
  const riffContext = useRiffContext();

  useEffect(() => {
    if (isMobile && isViewingDraft && selectedNote) {
      if (!riffContext.isRiffMode || riffContext.draftFilename !== selectedNote.filename) {
        riffContext.enterRiffMode(selectedNote.filename);
      }
    }
  }, [isMobile, isViewingDraft, selectedNote, riffContext]);

  return null;
};

// Wrapper to provide riff integration to NoteViewer
interface NoteViewerWithIntegrateProps {
  content: string;
  filename: string;
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
  conversations: { id: string; title?: string }[];
  notes: NoteInfo[];
  selectedModel: string;
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
}

const NoteViewerWithIntegrate: React.FC<NoteViewerWithIntegrateProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
  notes,
  selectedModel,
  onBack,
  canGoBack,
  onClose,
}) => {
  const riffContext = useRiffContext();

  const handleIntegrate = useCallback(async () => {
    if (selectedModel && filename) {
      // Set config and enter riff mode with this draft, then integrate
      riffContext.setConfig(selectedModel, notes);
      await riffContext.enterRiffMode(filename);
      await riffContext.integrateNow();
    }
  }, [riffContext, filename, selectedModel, notes]);

  return (
    <NoteViewer
      content={content}
      filename={filename}
      onNavigateToNote={onNavigateToNote}
      onNavigateToConversation={onNavigateToConversation}
      onIntegrate={handleIntegrate}
      conversations={conversations}
      onBack={onBack}
      canGoBack={canGoBack}
      onClose={onClose}
    />
  );
};

// Generate unique message ID for provenance tracking
const generateMessageId = () => `msg-${Math.random().toString(16).slice(2, 6)}`;

function AppContent() {
  const [config, setConfig] = useState<Config | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [showTriggerConfig, setShowTriggerConfig] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null);
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);

  // Selected item and navigation history
  const [selectedItem, setSelectedItem] = useState<SelectedItem>(null);
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
  type MobileView = 'list' | 'conversation';
  const [mobileView, setMobileView] = useState<MobileView>('list');

  // Check if selected note is a draft (for mobile riff mode)
  const isViewingDraft = selectedNote?.filename.startsWith('riffs/') &&
    !selectedNote.content.includes('integrated: true');

  // Message ID to scroll to after navigating to a conversation (for provenance links)
  const [pendingScrollToMessageId, setPendingScrollToMessageId] = useState<string | null>(null);
  const chatInterfaceRef = useRef<ChatInterfaceHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const { stopStreaming, getStreamingConversationIds, getUnreadConversationIds, markAsRead, addToolUse, startSubagents, updateSubagentContent, addSubagentToolUse, completeSubagent } = useStreamingContext();
  const { execute: executeWithTools } = useToolExecution();

  // Vault watcher callbacks
  const handleConversationAdded = useCallback(async (id: string) => {
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
    if (id === BACKGROUND_CONVERSATION_ID) {
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

      // Cmd+F: Find in current conversation
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        chatInterfaceRef.current?.openFind();
      }

      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false);
        return;
      }

      // Escape with no modals open: go back to background view
      // Skip if already handled (e.g. streaming stop) or if user is in a text field
      if (e.key === 'Escape' && !showSettings && !showTriggerConfig && selectedItem && !e.defaultPrevented) {
        setSelectedItem(null);
        setNoteContent(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, showTriggerConfig, selectedItem, config]);

  // Build unified timeline whenever data changes
  useEffect(() => {
    const items = vaultService.buildTimeline(conversations, notes, triggers);
    items.then(setTimelineItems);
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
        const bgDefaultModel = loadedConfig.favoriteModels?.[0] || providerRegistry.getAllAvailableModels()[0]?.key || '';

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
      anthropic: 'anthropic/claude-opus-4-5-20251101',
      openai: 'openai/gpt-4o',
      gemini: 'gemini/gemini-2.0-flash',
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
      alert('No provider configured. Please add a provider in Settings.');
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

  const generateFallbackTitle = (firstMessage: string): string => {
    const truncated = firstMessage.slice(0, 50);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  };

  const handleSaveImage = async (conversationId: string, imageData: Uint8Array, mimeType: string): Promise<Attachment> => {
    return await vaultService.saveImage(conversationId, imageData, mimeType);
  };

  const handleLoadImageAsBase64 = async (relativePath: string): Promise<{ base64: string; mimeType: string }> => {
    const base64 = await vaultService.loadImageAsBase64(relativePath);
    // Extract mimeType from path extension
    const ext = relativePath.split('.').pop()?.toLowerCase() || 'png';
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { base64, mimeType };
  };

  const handleSendMessage = async (content: string, attachments: Attachment[], onChunk?: (text: string) => void, signal?: AbortSignal): Promise<void> => {
    if (!currentConversation || !config) return;

    const providerType = getProviderFromModel(currentConversation.model);
    const modelId = getModelIdFromModel(currentConversation.model);
    const provider = providerRegistry.getProvider(providerType);
    if (!provider || !provider.isInitialized()) {
      alert(`Provider ${providerType} is not configured.`);
      return;
    }

    const userMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      timestamp: new Date().toISOString(),
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    const updatedMessages = [...currentConversation.messages, userMessage];

    const isFirstMessage = currentConversation.messages.filter(m => m.role !== 'log').length === 0;
    const title = isFirstMessage ? generateFallbackTitle(content) : currentConversation.title;

    // ID stays stable - no regeneration needed
    const updatedConversation: Conversation = {
      ...currentConversation,
      title,
      messages: updatedMessages,
      updated: new Date().toISOString(),
    };

    // Update draft or conversation in list
    setDraftConversation(prev => prev?.id === updatedConversation.id ? updatedConversation : prev);

    if (isFirstMessage) {
      setConversations((prev) => [updatedConversation, ...prev]);
    } else {
      setConversations(prev => prev.map(c => c.id === updatedConversation.id ? updatedConversation : c));
    }

    // Save immediately when user sends a message (so it pops to top of list)
    try {
      // Use the actual filename that will be generated (includes slug if title exists)
      const vaultPathForSave = vaultService.getVaultPath();
      const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
      if (vaultPathForSave) {
        const filePath = `${vaultPathForSave}/conversations/${filename}`;
        markSelfWrite(filePath);
        // Also mark old file path if it exists (title change causes old file deletion)
        const oldFilePath = await vaultService.getConversationFilePath(updatedConversation.id);
        if (oldFilePath) {
          markSelfWrite(oldFilePath);
        }
      }
      await vaultService.saveConversation(updatedConversation);
      const loadedConversations = await vaultService.loadConversations();
      setConversations(loadedConversations);
    } catch (saveError) {
      console.error('Error saving conversation on user message (non-fatal):', saveError);
    }

    // Track accumulated content locally so we can save partial results on cancel
    let accumulatedContent = '';
    const assistantMessageId = generateMessageId();

    // Helper to save partial/complete conversation
    const savePartialConversation = async (content: string) => {
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content,
      };
      const finalConv: Conversation = {
        ...updatedConversation,
        messages: [...updatedMessages, assistantMessage],
        updated: new Date().toISOString(),
      };
      setDraftConversation(prev => prev?.id === finalConv.id ? finalConv : prev);
      setConversations(prev => prev.map(c => c.id === finalConv.id ? finalConv : c));
      try {
        const vaultPathForSave = vaultService.getVaultPath();
        const filename = vaultService.generateFilename(finalConv.id, finalConv.title);
        if (vaultPathForSave) {
          const filePath = `${vaultPathForSave}/conversations/${filename}`;
          markSelfWrite(filePath);
        }
        await vaultService.saveConversation(finalConv);
      } catch (saveError) {
        console.error('Error saving partial conversation (non-fatal):', saveError);
      }
    };

    try {
      // Build system prompt with skill descriptions, conversation context, and memory
      const systemPrompt = skillRegistry.buildSystemPrompt({
        id: currentConversation.id,
        title: currentConversation.title,
      }, memory?.content);

      const imageLoader = async (relativePath: string) => {
        return await vaultService.loadImageAsBase64(relativePath);
      };

      // Execute with tool loop support
      const convId = currentConversation.id;
      const result = await executeWithTools(provider, updatedMessages, modelId, {
        maxIterations: 10,
        toolContext: {
          messageId: assistantMessageId,
          conversationId: `conversations/${convId}`,
        },
        onChunk: onChunk ? (chunk: string) => {
          accumulatedContent += chunk;
          onChunk(chunk);
        } : undefined,
        onToolUse: (toolUse) => addToolUse(convId, toolUse),
        signal,
        imageLoader,
        systemPrompt,
        // Sub-agent streaming callbacks
        onSubagentStart: (agents) => startSubagents(convId, agents),
        onSubagentChunk: (agentId, chunk) => updateSubagentContent(convId, agentId, chunk),
        onSubagentToolUse: (agentId, toolUse) => addSubagentToolUse(convId, agentId, toolUse),
        onSubagentComplete: (agentId, _content, error) => completeSubagent(convId, agentId, error),
      });

      // Provider returned normally after abort — save partial content
      if (signal?.aborted && accumulatedContent.trim()) {
        await savePartialConversation(accumulatedContent);
        return;
      }

      // Build usage with cost estimate
      let usage: import('./types').Usage | undefined;
      if (result.usage) {
        const cost = estimateCost(currentConversation.model, result.usage.inputTokens, result.usage.outputTokens);
        usage = {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(cost !== undefined && { cost }),
          ...(result.usage.responseId && { responseId: result.usage.responseId }),
        };
      }

      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: result.finalContent,
        toolUse: result.allToolUses.length > 0 ? result.allToolUses : undefined,
        skillUse: result.skillUses.length > 0 ? result.skillUses : undefined,
        subagentResponses: result.subagentResponses.length > 0 ? result.subagentResponses : undefined,
        usage,
      };

      let finalConversation: Conversation = {
        ...updatedConversation,
        messages: [...updatedMessages, assistantMessage],
      };

      // Generate better title using LLM for first message
      if (isFirstMessage) {
        try {
          const betterTitle = await provider.generateTitle(content, result.finalContent);
          if (betterTitle && betterTitle !== finalConversation.title) {
            finalConversation = {
              ...finalConversation,
              title: betterTitle,
            };
          }
        } catch (titleError) {
          console.error('Failed to generate title (non-fatal):', titleError);
        }
      }

      // Only update if user is still viewing this conversation
      setDraftConversation(prev => prev?.id === finalConversation.id ? finalConversation : prev);
      setConversations(prev => prev.map(c => c.id === finalConversation.id ? finalConversation : c));

      try {
        // Mark as self-write to avoid watcher triggering on our own save
        const vaultPathForFinal = vaultService.getVaultPath();
        const filename = vaultService.generateFilename(finalConversation.id, finalConversation.title);
        if (vaultPathForFinal) {
          const filePath = `${vaultPathForFinal}/conversations/${filename}`;
          markSelfWrite(filePath);
          // Also mark old file path if it exists (title change causes old file deletion)
          const oldFilePath = await vaultService.getConversationFilePath(finalConversation.id);
          if (oldFilePath) {
            markSelfWrite(oldFilePath);
          }
        }
        await vaultService.saveConversation(finalConversation);
      } catch (saveError) {
        console.error('Error saving conversation (non-fatal):', saveError);
      }

      try {
        const loadedConversations = await vaultService.loadConversations();
        setConversations(loadedConversations);
      } catch (loadError) {
        console.error('Error loading conversations list (non-fatal):', loadError);
      }
    } catch (error: any) {
      // If aborted, save any partial content that was streamed
      if (error?.name === 'AbortError' || signal?.aborted) {
        if (accumulatedContent.trim()) {
          await savePartialConversation(accumulatedContent);
        }
        return;
      }

      console.error('Error sending message:', error);

      let errorMessage = 'Error sending message. Please check your configuration and try again.';

      if (error?.message?.includes('API key') || error?.message?.includes('401')) {
        errorMessage = 'Invalid API key. Please check your configuration.';
      } else if (error?.message?.includes('rate limit') || error?.message?.includes('429')) {
        errorMessage = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (error?.message?.includes('network') || error?.message?.includes('fetch') || error?.message?.includes('Failed to fetch')) {
        errorMessage = 'Network error. Please check your internet connection.';
      }

      alert(errorMessage);

      // Only revert if user is still viewing this conversation
      setDraftConversation(prev => prev?.id === currentConversation.id ? currentConversation : prev);
      if (isFirstMessage) {
        setConversations((prev) => prev.filter(c => c.id !== currentConversation.id));
      } else {
        setConversations(prev => prev.map(c => c.id === currentConversation.id ? currentConversation : c));
      }
    }
  };

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
      alert('Failed to rename conversation. Please try again.');
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
      alert('Failed to rename riff. Please try again.');
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
      alert('Failed to delete conversation. Please try again.');
    }
  };


  if (isLoading) {
    return <div className="loading">Loading...</div>;
  }

  if (!config) {
    return (
      <VaultSetup
        onVaultSelected={handleVaultSelected}
        onExistingVault={loadVault}
      />
    );
  }

  // Handle deleting a trigger
  const handleDeleteTrigger = async (triggerId: string) => {
    const vaultPathForDelete = vaultService.getVaultPath();
    if (!vaultPathForDelete) return;

    try {
      const { remove } = await import('@tauri-apps/plugin-fs');
      const { join } = await import('@tauri-apps/api/path');
      const triggerPath = await join(vaultPathForDelete, 'triggers', `${triggerId}.yaml`);
      await remove(triggerPath);

      // Update state
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
    const defaultModel = config?.favoriteModels?.[0] || availableModels[0]?.key || trigger.model;

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

  // Handle updating an existing trigger
  const handleUpdateTrigger = async (triggerId: string, data: TriggerFormData) => {
    const vaultPathForUpdate = vaultService.getVaultPath();
    if (!vaultPathForUpdate) return;

    try {
      // Atomic read-modify-write to avoid race conditions
      const updated = await vaultService.updateTrigger(triggerId, (fresh) => ({
        ...fresh,
        model: data.model,
        enabled: data.enabled,
        triggerPrompt: data.triggerPrompt,
        intervalMinutes: data.intervalMinutes,
      }));

      if (updated) {
        const filePath = await vaultService.getTriggerFilePath(triggerId);
        if (filePath) markSelfWrite(filePath);

        // Update state with the result
        setTriggers(prev => prev.map(t => t.id === triggerId ? updated : t));
      }
    } catch (error) {
      console.error('Error updating trigger:', error);
    }
  };

  // Handle creating a new trigger
  const handleCreateTrigger = async (data: TriggerFormData) => {
    const vaultPathForCreate = vaultService.getVaultPath();
    if (!vaultPathForCreate) return;

    // Generate trigger ID
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);

    // Create a new trigger (flat structure)
    const newTrigger: Trigger = {
      id: `${date}-${time}-${hash}`,
      created: now.toISOString(),
      updated: now.toISOString(),
      title: data.title,
      model: data.model,
      enabled: data.enabled,
      triggerPrompt: data.triggerPrompt,
      intervalMinutes: data.intervalMinutes,
      messages: [],
    };

    // Save to vault (triggers/ directory)
    try {
      const filePath = `${vaultPathForCreate}/triggers/${newTrigger.id}.yaml`;
      markSelfWrite(filePath);
      await vaultService.saveTrigger(newTrigger);

      // Update state
      setTriggers(prev => [newTrigger, ...prev]);
      setDraftConversation(null);
      setNoteContent(null);
      navigateTo({ type: 'trigger', id: newTrigger.id });

      // Establish baseline in background (non-blocking)
      if (newTrigger.enabled) {
        triggerExecutor.executeBaselineCheck(newTrigger).then(async ({ triggerResult: result, usage: baselineUsage }) => {
          if (result.result === 'triggered') {
            const baselineTime = new Date().toISOString();
            const updatedTrigger: Trigger = {
              ...newTrigger,
              updated: baselineTime,
              messages: [
                { role: 'user', timestamp: baselineTime, content: newTrigger.triggerPrompt },
                { role: 'assistant', timestamp: baselineTime, content: result.response, model: newTrigger.model, usage: baselineUsage },
              ],
              lastChecked: baselineTime,
              lastTriggered: baselineTime,
              history: [{ timestamp: baselineTime, result: 'triggered', reasoning: 'Baseline established', usage: baselineUsage }],
            };
            await handleTriggerUpdated(updatedTrigger);
          }
        }).catch(err => console.warn('Failed to establish trigger baseline:', err));
      }
    } catch (error) {
      console.error('Error creating trigger:', error);
    }
  };

  return (
    <TriggerProvider
      getTriggers={getTriggers}
      onTriggerUpdated={handleTriggerUpdated}
      vaultPath={vaultPath}
    >
      <RiffProvider>
      <BackgroundProvider
        initialConversation={backgroundConversation}
        defaultModel={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
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
        <RiffApprovalModal />
        <MobileRiffModeEffect
          isMobile={isMobile}
          isViewingDraft={isViewingDraft ?? false}
          selectedNote={selectedNote}
        />
        <div className="app">
        {isMobile ? (
          // Mobile layout - show one view at a time
          mobileView === 'list' ? (
            <SidebarWithRiff
              ref={sidebarRef}
              fullScreen
              onMobileBack={() => setMobileView('conversation')}
              onClearSelection={() => { setSelectedItem(null); setNoteContent(null); }}
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
              onNewTrigger={() => setShowTriggerConfig(true)}
              onRenameConversation={handleRenameConversation}
              onRenameRiff={handleRenameRiff}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTrigger={handleDeleteTrigger}
              onDeleteNote={handleDeleteNote}
            />
          ) : selectedItem?.type === 'trigger' && selectedTrigger ? (
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
              <div className="main-panel">
                <RiffView
                  notes={notes}
                  model={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
                  sonioxApiKey={config?.SONIOX_API_KEY}
                  onNavigateToNote={handleSelectNote}
                  onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                  conversations={conversations}
                  onBack={() => setMobileView('list')}
                  canGoBack={true}
                />
              </div>
            ) : selectedNote ? (
              <NoteViewerWithIntegrate
                content={selectedNote.content}
                filename={selectedNote.filename}
                onNavigateToNote={handleSelectNote}
                onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
                conversations={conversations}
                notes={notes}
                selectedModel={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
                onBack={() => setMobileView('list')}
                canGoBack={true}
              />
            ) : (
              // Loading state while note content loads
              <div className="main-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span>Loading...</span>
              </div>
            )
          ) : (
            // Mobile: conversation view
            <ChatInterface
              ref={chatInterfaceRef}
              conversation={currentConversation}
              onSendMessage={handleSendMessage}
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
            />
          )
        ) : (
          // Desktop layout - sidebar + main panel
          <>
            <SidebarWithRiff
              ref={sidebarRef}
              onClearSelection={() => { setSelectedItem(null); setNoteContent(null); }}
              timelineItems={timelineItems}
              activeFilter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedItemId={selectedItemId}
              onSelectItem={handleSelectItem}
              streamingConversationIds={getStreamingConversationIds()}
              unreadConversationIds={getUnreadConversationIds()}
              availableModels={availableModels}
              onNewConversation={handleNewConversation}
              onNewTrigger={() => setShowTriggerConfig(true)}
              onRenameConversation={handleRenameConversation}
              onRenameRiff={handleRenameRiff}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTrigger={handleDeleteTrigger}
              onDeleteNote={handleDeleteNote}
            />
      <MainPanelWithRiff
        notes={notes}
        selectedModel={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
        sonioxApiKey={config?.SONIOX_API_KEY}
        onNavigateToNote={handleSelectNote}
        onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
        conversations={conversations}
        selectedNote={selectedNote}
        hasAnySelection={!!(currentConversation || selectedTrigger || (selectedNote && (!selectedNote.filename.startsWith('riffs/') || selectedNote.content.includes('integrated: true'))))}
        onBack={goBack}
        canGoBack={canGoBack}
        onClose={() => { setSelectedItem(null); setNoteContent(null); }}
      >
      <div className="main-panel">
        {selectedTrigger ? (
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
              // Refresh trigger data after manual run
              const refreshed = await vaultService.loadTrigger(selectedTrigger.id);
              if (refreshed) {
                setTriggers(prev => prev.map(t => t.id === refreshed.id ? refreshed : t));
              }
            }}
            onAskAbout={handleAskAboutTrigger}
            onTriggerUpdated={(updated) => {
              // Update triggers list - selectedTrigger will auto-update since it's derived
              setTriggers(prev => prev.map(t => t.id === updated.id ? updated : t));
            }}
          />
        ) : selectedNote ? (
          <NoteViewerWithIntegrate
            content={selectedNote.content}
            filename={selectedNote.filename}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId, messageId) => handleSelectConversation(conversationId, true, messageId)}
            conversations={conversations}
            notes={notes}
            selectedModel={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
            onBack={goBack}
            canGoBack={canGoBack}
            onClose={() => { setSelectedItem(null); setNoteContent(null); }}
          />
        ) : currentConversation ? (
          <ChatInterface
            ref={chatInterfaceRef}
            conversation={currentConversation}
            onSendMessage={handleSendMessage}
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
      </MainPanelWithRiff>
          </>
        )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          vaultPath={vaultPath}
        />
      )}
      {showTriggerConfig && (
        <TriggerConfigModal
          trigger={editingTrigger}
          availableModels={availableModels}
          favoriteModels={config?.favoriteModels}
          onSave={async (data) => {
            if (editingTrigger) {
              // Editing existing trigger
              await handleUpdateTrigger(editingTrigger.id, data);
            } else {
              // Creating new trigger
              await handleCreateTrigger(data);
            }
            setEditingTrigger(null);
            setShowTriggerConfig(false);
          }}
          onClose={() => {
            setShowTriggerConfig(false);
            setEditingTrigger(null);
          }}
        />
      )}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      </div>
      </BackgroundProvider>
      </RiffProvider>
    </TriggerProvider>
  );
}

function App() {
  return (
    <StreamingProvider>
      <ApprovalProvider>
        <ContextMenuProvider>
          <AppContent />
          <ContextMenu />
        </ContextMenuProvider>
      </ApprovalProvider>
    </StreamingProvider>
  );
}

export default App;
