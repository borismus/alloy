import { useState, useEffect, useRef, useCallback, forwardRef } from 'react';
import { vaultService } from './services/vault';
import { providerRegistry } from './services/providers';
import { skillRegistry } from './services/skills';
import { rambleService } from './services/ramble';
import { useVaultWatcher } from './hooks/useVaultWatcher';
import { useIsMobile } from './hooks/useIsMobile';
import { useStreamingContext, StreamingProvider } from './contexts/StreamingContext';
import { TriggerProvider } from './contexts/TriggerContext';
import { ApprovalProvider } from './contexts/ApprovalContext';
import { Conversation, Config, Message, ProviderType, ModelInfo, ComparisonMetadata, CouncilMetadata, Attachment, formatModelId, getProviderFromModel, getModelIdFromModel, NoteInfo, TimelineFilter, TimelineItem, Trigger, SelectedItem } from './types';
import { useToolExecution } from './hooks/useToolExecution';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { ComparisonChatInterface, ComparisonChatInterfaceHandle } from './components/ComparisonChatInterface';
import { ComparisonModelSelector } from './components/ComparisonModelSelector';
import { CouncilModelSelector } from './components/CouncilModelSelector';
import { CouncilChatInterface, CouncilChatInterfaceHandle } from './components/CouncilChatInterface';
import { Sidebar, SidebarHandle } from './components/Sidebar';
import { Settings } from './components/Settings';
import { TriggerConfigModal, TriggerFormData } from './components/TriggerConfigModal';
import { TriggerDetailView } from './components/TriggerDetailView';
import { NoteViewer } from './components/NoteViewer';
// MobileNewConversation removed - ChatInterface handles both new and existing conversations
import { UpdateChecker } from './components/UpdateChecker';
import { MemoryWarning } from './components/MemoryWarning';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { isServerMode } from './mocks';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { RambleProvider, useRambleContext } from './contexts/RambleContext';
import { RambleBatchApprovalModal } from './components/RambleBatchApprovalModal';
import { RambleView } from './components/RambleView';
import { ContextMenu } from './components/ContextMenu';
import './App.css';

// Wrapper component to access RambleContext and show approval modal
const RambleApprovalModal: React.FC = () => {
  const rambleContext = useRambleContext();

  if (rambleContext.phase !== 'approving') return null;

  return (
    <RambleBatchApprovalModal
      proposedChanges={rambleContext.proposedChanges}
      isProcessing={rambleContext.isProcessing}
      onApply={rambleContext.applyChanges}
      onCancel={rambleContext.cancelIntegration}
    />
  );
};

// Wrapper component for main panel that can access RambleContext
interface MainPanelWithRambleProps {
  notes: NoteInfo[];
  selectedModel: string;
  onNavigateToNote: (filename: string) => void;
  selectedNote: { filename: string; content: string } | null;
  hasNonRambleSelection: boolean; // true if user selected conversation or trigger (not note)
  onClearNote: () => void; // clear the selected note when entering ramble mode
  children: React.ReactNode;
}

const MainPanelWithRamble: React.FC<MainPanelWithRambleProps> = ({
  notes,
  selectedModel,
  onNavigateToNote,
  selectedNote,
  hasNonRambleSelection,
  onClearNote,
  children,
}) => {
  const rambleContext = useRambleContext();

  // Check if selected note is a ramble/draft (not integrated)
  const isRambleNote = selectedNote?.filename.startsWith('rambles/') &&
    !selectedNote.content.includes('integrated: true');

  console.log('[MainPanelWithRamble]', {
    isRambleMode: rambleContext.isRambleMode,
    activeDraftFilename: rambleContext.activeDraftFilename,
    selectedNote: selectedNote?.filename,
    isRambleNote,
    hasNonRambleSelection,
  });

  // Auto-enter ramble mode when viewing a draft note, or switch drafts if already in ramble mode
  useEffect(() => {
    if (isRambleNote && selectedNote) {
      // Either entering ramble mode, or switching to a different draft
      if (!rambleContext.isRambleMode || rambleContext.activeDraftFilename !== selectedNote.filename) {
        console.log('[MainPanelWithRamble] Entering/switching ramble mode with draft:', selectedNote.filename);
        rambleContext.enterRambleMode(selectedNote.filename);
        onClearNote(); // Clear note selection so ramble mode takes over
      }
    }
  }, [isRambleNote, selectedNote, rambleContext.isRambleMode, rambleContext.activeDraftFilename, onClearNote]);

  // Auto-exit ramble mode when user navigates to non-ramble content
  useEffect(() => {
    if (rambleContext.isRambleMode && hasNonRambleSelection) {
      rambleContext.ripDraft();
      rambleContext.exitRambleMode();
    }
  }, [hasNonRambleSelection, rambleContext]);

  // Show RambleView when in ramble mode
  if (rambleContext.isRambleMode && !hasNonRambleSelection) {
    console.log('[MainPanelWithRamble] Showing RambleView');
    return (
      <div className="main-panel">
        <RambleView
          notes={notes}
          model={selectedModel}
          onNavigateToNote={onNavigateToNote}
          onExit={() => rambleContext.exitRambleMode()}
        />
      </div>
    );
  }

  return <>{children}</>;
};

// Wrapper to get onNewRamble handler for Sidebar
type SidebarWithRambleProps = Omit<React.ComponentProps<typeof Sidebar>, 'onNewRamble'>;

const SidebarWithRamble = forwardRef<SidebarHandle, SidebarWithRambleProps>(
  function SidebarWithRamble(props: SidebarWithRambleProps, ref: React.Ref<SidebarHandle>) {
    const rambleContext = useRambleContext();

    const handleNewRamble = useCallback(() => {
      rambleContext.enterRambleMode();
    }, [rambleContext]);

    return <Sidebar ref={ref} {...props} onNewRamble={handleNewRamble} />;
  }
);

// Wrapper to provide ramble integration to NoteViewer
interface NoteViewerWithIntegrateProps {
  content: string;
  filename: string;
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
  conversations: { id: string; title?: string }[];
  notes: NoteInfo[];
  selectedModel: string;
  canGoBack?: boolean;
  onGoBack?: () => void;
}

const NoteViewerWithIntegrate: React.FC<NoteViewerWithIntegrateProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
  notes,
  selectedModel,
  canGoBack,
  onGoBack,
}) => {
  const rambleContext = useRambleContext();

  const handleIntegrate = useCallback(() => {
    if (selectedModel && filename) {
      rambleContext.integrateExistingRamble(filename, selectedModel, notes);
    }
  }, [rambleContext, filename, selectedModel, notes]);

  return (
    <NoteViewer
      content={content}
      filename={filename}
      onNavigateToNote={onNavigateToNote}
      onNavigateToConversation={onNavigateToConversation}
      onIntegrate={handleIntegrate}
      conversations={conversations}
      canGoBack={canGoBack}
      onGoBack={onGoBack}
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
  const [showComparisonSelector, setShowComparisonSelector] = useState(false);
  const [showCouncilSelector, setShowCouncilSelector] = useState(false);
  const [showTriggerConfig, setShowTriggerConfig] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null);
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  // Unified selection state - single source of truth for what's selected
  const [selectedItem, setSelectedItem] = useState<SelectedItem>(null);
  // Cached note content (loaded on demand when note is selected)
  const [noteContent, setNoteContent] = useState<string | null>(null);
  // Transient conversation state for new/unsaved conversations
  const [draftConversation, setDraftConversation] = useState<Conversation | null>(null);
  // Memory content and size for system prompt injection
  const [memory, setMemory] = useState<{ content: string; sizeBytes: number } | null>(null);

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

  // Navigation history for back button support
  type NavigationEntry =
    | { type: 'note'; filename: string; content: string }
    | { type: 'conversation'; id: string };
  const [navigationHistory, setNavigationHistory] = useState<NavigationEntry[]>([]);
  // Mobile navigation state
  const isMobile = useIsMobile();
  type MobileView = 'list' | 'conversation';
  const [mobileView, setMobileView] = useState<MobileView>('conversation');

  // Message ID to scroll to after navigating to a conversation (for provenance links)
  const [pendingScrollToMessageId, setPendingScrollToMessageId] = useState<string | null>(null);
  const chatInterfaceRef = useRef<ChatInterfaceHandle>(null);
  const comparisonChatInterfaceRef = useRef<ComparisonChatInterfaceHandle>(null);
  const councilChatInterfaceRef = useRef<CouncilChatInterfaceHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const { stopStreaming, getStreamingConversationIds, getUnreadConversationIds, markAsRead, addToolUse } = useStreamingContext();
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
    setSelectedItem(prev => prev?.type === 'conversation' && prev.id === id ? null : prev);
    setDraftConversation(prev => prev?.id === id ? null : prev);
  }, []);

  const handleConversationModified = useCallback(async (id: string) => {
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
    console.log('[App] handleNoteModified called:', filename);

    // Reload the notes list
    const loadedNotes = await vaultService.loadNotes();
    setNotes(loadedNotes);

    // Refresh memory if memory.md was modified
    if (filename === 'memory.md') {
      const loadedMemory = await vaultService.loadMemory();
      setMemory(loadedMemory);
    }

    // If the modified note is currently selected, refresh its content
    setSelectedItem(prev => {
      if (prev?.type === 'note' && prev.id === filename) {
        // Re-read the file content asynchronously
        const vaultPathStr = vaultService.getVaultPath();
        const notesPath = vaultService.getNotesPath();
        if (vaultPathStr && notesPath) {
          // memory.md and rambles/ are at vault root, other notes are in notes/
          const notePath = filename === 'memory.md' || filename.startsWith('rambles/')
            ? `${vaultPathStr}/${filename}`
            : `${notesPath}/${filename}`;
          console.log('[App] Refreshing note content from:', notePath);
          readTextFile(notePath).then(content => {
            console.log('[App] Note content refreshed, length:', content.length);
            setNoteContent(content);
          }).catch(error => {
            console.error('Failed to refresh note content:', error);
          });
        }
      }
      return prev; // Don't change selection, just trigger content refresh
    });
  }, []);

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
          console.log('[App] Server mode detected, loading vault');
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, config]);

  // Build unified timeline whenever data changes
  useEffect(() => {
    const items = vaultService.buildTimeline(conversations, notes, triggers);
    items.then(setTimelineItems);
  }, [conversations, notes, triggers]);

  // Compute selected item ID for sidebar highlighting
  const selectedItemId = selectedItem?.id ?? null;

  // Handle selecting an item from the timeline
  const handleSelectItem = useCallback(async (item: TimelineItem) => {
    // Set unified selection state
    const newSelection: SelectedItem = item.type === 'ramble'
      ? { type: 'note', id: item.id }
      : { type: item.type, id: item.id };
    setSelectedItem(newSelection);

    // Clear draft conversation when switching away from it
    setDraftConversation(null);

    if (item.type === 'conversation') {
      // Mark as read when user selects the conversation
      markAsRead(item.id);
    } else if (item.type === 'note' || item.type === 'ramble') {
      // Load note content
      const vaultPathStr = vaultService.getVaultPath();
      const notesPath = vaultService.getNotesPath();
      if (vaultPathStr && notesPath) {
        const notePath = item.id === 'memory.md' || item.id.startsWith('rambles/')
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
  }, [markAsRead]);

  // Handle deleting a note
  const handleDeleteNote = useCallback(async (filename: string) => {
    await vaultService.deleteNote(filename);
    // If this is the selected note, clear the selection
    setSelectedItem(prev => prev?.type === 'note' && prev.id === filename ? null : prev);
    setNoteContent(null);
    // Reload notes list
    const loadedNotes = await vaultService.loadNotes();
    setNotes(loadedNotes);
  }, []);

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

        const loadedConversations = await vaultService.loadConversations();
        setConversations(loadedConversations);

        // Load triggers from triggers/ directory
        const loadedTriggers = await vaultService.loadTriggers();
        setTriggers(loadedTriggers);

        // Load notes from vault
        const loadedNotes = await vaultService.loadNotes();
        console.log('[App] Loaded notes:', loadedNotes.length, loadedNotes);
        setNotes(loadedNotes);

        // Load skills from vault
        skillRegistry.setVaultPath(path);
        await skillRegistry.loadSkills();

        // Initialize ramble service
        rambleService.setVaultPath(path);

        // Load memory for system prompt injection
        const loadedMemory = await vaultService.loadMemory();
        setMemory(loadedMemory);
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
    // Save the provider credential to config
    const configKey = provider === 'ollama' ? 'OLLAMA_BASE_URL' :
                      provider === 'openai' ? 'OPENAI_API_KEY' :
                      provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';

    // Default models for each provider (using provider/model format)
    const defaultModels: Record<ProviderType, string> = {
      anthropic: 'anthropic/claude-opus-4-5-20251101',
      openai: 'openai/gpt-4o',
      gemini: 'gemini/gemini-2.0-flash',
      ollama: '', // Ollama models are discovered dynamically
    };

    const newConfig: Config = {
      defaultModel: defaultModels[provider],
      [configKey]: credential,
    };

    vaultService.setVaultPath(path);
    await vaultService.saveConfig(newConfig);
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
    setSelectedItem({ type: 'conversation', id: newConversation.id });
  };

  // Auto-create a new conversation when entering mobile conversation view without one
  useEffect(() => {
    if (isMobile && mobileView === 'conversation' && !currentConversation && config && availableModels.length > 0) {
      handleNewConversation();
    }
  }, [isMobile, mobileView, currentConversation, config, availableModels.length]);

  const handleSelectNote = async (filename: string, addToHistory = true) => {
    console.log('[App] handleSelectNote called:', filename);
    const vaultPathStr = vaultService.getVaultPath();
    const notesPath = vaultService.getNotesPath();
    if (vaultPathStr && notesPath) {
      // Don't navigate to the same note we're already viewing
      if (selectedItem?.type === 'note' && selectedItem.id === filename) {
        console.log('[App] Skipping - same note already selected');
        return;
      }

      // memory.md and rambles/ are at vault root, other notes are in notes/
      const notePath = filename === 'memory.md' || filename.startsWith('rambles/')
        ? `${vaultPathStr}/${filename}`
        : `${notesPath}/${filename}`;
      try {
        console.log('[App] Reading note from:', notePath);
        const content = await readTextFile(notePath);
        // Push current view to history before navigating
        if (addToHistory) {
          if (selectedItem?.type === 'note' && noteContent) {
            setNavigationHistory(prev => [...prev, { type: 'note', filename: selectedItem.id, content: noteContent }]);
          } else if (selectedItem?.type === 'conversation') {
            setNavigationHistory(prev => [...prev, { type: 'conversation', id: selectedItem.id }]);
          }
        }
        // Clear draft conversation and update selection
        setDraftConversation(null);
        setSelectedItem({ type: 'note', id: filename });
        console.log('[App] Setting note content:', { filename, contentLength: content.length });
        setNoteContent(content);
      } catch (error) {
        console.error('[App] Failed to load note:', error);
      }
    }
  };

  const handleNewComparison = () => {
    if (availableModels.length < 2) {
      alert('You need at least 2 models available to create a comparison. Please configure additional providers in Settings.');
      return;
    }
    setShowComparisonSelector(true);
  };

  const handleNewCouncil = () => {
    if (availableModels.length < 2) {
      alert('You need at least 2 models available to create a council. Please configure additional providers in Settings.');
      return;
    }
    setShowCouncilSelector(true);
  };

  const handleStartComparison = (selectedModels: ModelInfo[]) => {
    if (selectedModels.length < 2) return;

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);

    const comparisonMetadata: ComparisonMetadata = {
      isComparison: true,
      models: selectedModels.map(m => m.key),
    };

    const newConversation: Conversation = {
      id: `${date}-${time}-${hash}-compare`,
      created: now.toISOString(),
      updated: now.toISOString(),
      model: selectedModels[0].key,
      messages: [],
      comparison: comparisonMetadata,
    };

    setDraftConversation(newConversation);
    setNoteContent(null);
    setSelectedItem({ type: 'conversation', id: newConversation.id });
    setShowComparisonSelector(false);
  };

  const handleStartCouncil = (councilMembers: ModelInfo[], chairman: ModelInfo) => {
    if (councilMembers.length < 2) return;

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);

    const councilMetadata: CouncilMetadata = {
      isCouncil: true,
      councilMembers: councilMembers.map(m => m.key),
      chairman: chairman.key,
    };

    const newConversation: Conversation = {
      id: `${date}-${time}-${hash}-council`,
      created: now.toISOString(),
      updated: now.toISOString(),
      model: chairman.key,
      messages: [],
      council: councilMetadata,
    };

    setDraftConversation(newConversation);
    setNoteContent(null);
    setSelectedItem({ type: 'conversation', id: newConversation.id });
    setShowCouncilSelector(false);
  };

  const handleUpdateCouncilConversation = async (updatedConversation: Conversation) => {
    // Update draft or conversation in list
    setDraftConversation(prev => prev?.id === updatedConversation.id ? updatedConversation : prev);
    setConversations(prev => prev.map(c => c.id === updatedConversation.id ? updatedConversation : c));

    // Check if this is the first message (conversation needs to be added to list)
    const existingConversation = conversations.find(c => c.id === updatedConversation.id);
    const isNewConversation = !existingConversation && updatedConversation.messages.length > 0;
    if (isNewConversation) {
      setConversations(prev => [updatedConversation, ...prev]);
    }

    // Save to vault
    try {
      const vaultPathForSave = vaultService.getVaultPath();
      if (vaultPathForSave) {
        const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
        const filePath = `${vaultPathForSave}/conversations/${filename}`;
        markSelfWrite(filePath);
        const oldFilePath = await vaultService.getConversationFilePath(updatedConversation.id);
        if (oldFilePath) {
          markSelfWrite(oldFilePath);
        }
      }

      if (isNewConversation) {
        // First save - no race condition possible, use direct save
        await vaultService.saveConversation(updatedConversation);
      } else {
        // Existing conversation - use atomic update to avoid race conditions
        await vaultService.updateConversation(updatedConversation.id, (fresh) => ({
          ...fresh,
          ...updatedConversation,
        }));
      }
      const loadedConversations = await vaultService.loadConversations();
      setConversations(loadedConversations);
    } catch (error) {
      console.error('Error saving council conversation:', error);
    }
  };

  const handleUpdateComparisonConversation = async (updatedConversation: Conversation) => {
    // Update draft or conversation in list
    setDraftConversation(prev => prev?.id === updatedConversation.id ? updatedConversation : prev);
    setConversations(prev => prev.map(c => c.id === updatedConversation.id ? updatedConversation : c));

    // Check if this is the first message (conversation needs to be added to list)
    const existingConversation = conversations.find(c => c.id === updatedConversation.id);
    const isNewConversation = !existingConversation && updatedConversation.messages.length > 0;
    if (isNewConversation) {
      setConversations(prev => [updatedConversation, ...prev]);
    }

    // Save to vault
    try {
      // Mark as self-write to avoid watcher triggering on our own save
      const vaultPathForSave = vaultService.getVaultPath();
      if (vaultPathForSave) {
        const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
        const filePath = `${vaultPathForSave}/conversations/${filename}`;
        markSelfWrite(filePath);
        // Also mark old file path if it exists (title change causes old file deletion)
        const oldFilePath = await vaultService.getConversationFilePath(updatedConversation.id);
        if (oldFilePath) {
          markSelfWrite(oldFilePath);
        }
      }

      if (isNewConversation) {
        // First save - no race condition possible, use direct save
        await vaultService.saveConversation(updatedConversation);
      } else {
        // Existing conversation - use atomic update to avoid race conditions
        await vaultService.updateConversation(updatedConversation.id, (fresh) => ({
          ...fresh,
          ...updatedConversation,
        }));
      }
      const loadedConversations = await vaultService.loadConversations();
      setConversations(loadedConversations);
    } catch (error) {
      console.error('Error saving comparison conversation:', error);
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

    try {
      // Build system prompt with skill descriptions, conversation context, and memory
      const systemPrompt = skillRegistry.buildSystemPrompt({
        id: currentConversation.id,
        title: currentConversation.title,
      }, memory?.content);

      const imageLoader = async (relativePath: string) => {
        return await vaultService.loadImageAsBase64(relativePath);
      };

      // Generate message ID for provenance tracking
      const assistantMessageId = generateMessageId();

      // Execute with tool loop support
      const result = await executeWithTools(provider, updatedMessages, modelId, {
        maxIterations: 10,
        toolContext: {
          messageId: assistantMessageId,
          conversationId: `conversations/${currentConversation.id}`,
        },
        onChunk,
        onToolUse: (toolUse) => addToolUse(currentConversation.id, toolUse),
        signal,
        imageLoader,
        systemPrompt,
      });

      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: result.finalContent,
        toolUse: result.allToolUses.length > 0 ? result.allToolUses : undefined,
        skillUse: result.skillUses.length > 0 ? result.skillUses : undefined,
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
      // If aborted, don't show error - just silently stop
      if (error?.name === 'AbortError' || signal?.aborted) {
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

  const handleSelectConversation = async (id: string, addToHistory = true, messageId?: string) => {
    console.log('[App] handleSelectConversation called with id:', id, 'messageId:', messageId);

    // Store messageId for scrolling after conversation loads
    setPendingScrollToMessageId(messageId || null);

    // Don't navigate to the same conversation we're already viewing
    if (currentConversation?.id === id && !selectedNote) {
      return;
    }

    // Mark as read when user selects the conversation
    markAsRead(id);

    // Push current view to history before navigating
    if (addToHistory) {
      if (selectedNote) {
        setNavigationHistory(prev => [...prev, { type: 'note', filename: selectedNote.filename, content: selectedNote.content }]);
      } else if (currentConversation) {
        setNavigationHistory(prev => [...prev, { type: 'conversation', id: currentConversation.id }]);
      }
    }

    // Close any open selectors/views and clear other selections
    setShowComparisonSelector(false);
    setShowCouncilSelector(false);
    setNoteContent(null);
    setDraftConversation(null);
    setSelectedItem({ type: 'conversation', id });

    // Focus input after selection
    setTimeout(() => {
      chatInterfaceRef.current?.focusInput();
    }, 0);
  };

  const handleGoBack = async () => {
    if (navigationHistory.length === 0) return;

    const previousEntry = navigationHistory[navigationHistory.length - 1];
    setNavigationHistory(prev => prev.slice(0, -1));

    if (previousEntry.type === 'note') {
      // Navigate back to note without adding to history
      setDraftConversation(null);
      setSelectedItem({ type: 'note', id: previousEntry.filename });
      setNoteContent(previousEntry.content);
    } else if (previousEntry.type === 'conversation') {
      // Navigate back to conversation without adding to history
      await handleSelectConversation(previousEntry.id, false);
    }
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

  const handleConfigReload = async () => {
    const vaultPathForReload = vaultService.getVaultPath();
    if (vaultPathForReload) {
      await loadVault(vaultPathForReload);
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

  const isComparisonConversation = currentConversation?.comparison !== undefined;
  const isCouncilConversation = currentConversation?.council !== undefined;

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
    const newId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const defaultModel = config?.favoriteModels?.[0] || availableModels[0]?.key || trigger.model;

    const newConversation: Conversation = {
      id: newId,
      created: now,
      updated: now,
      model: defaultModel,
      title: `Re: ${trigger.title || 'Trigger'}`,
      messages: [
        {
          role: 'log',
          content: `Context from monitor "${trigger.title}":\n\n${latestResponse.content}`,
          timestamp: now,
        },
      ],
    };

    // Save the new conversation
    await vaultService.saveConversation(newConversation);

    // Update state
    setConversations(prev => [newConversation, ...prev]);
    setDraftConversation(null);
    setSelectedItem({ type: 'conversation', id: newConversation.id });
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
      setSelectedItem({ type: 'trigger', id: newTrigger.id });
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
      <RambleProvider onSelectNote={handleSelectNote}>
        <UpdateChecker />
        {memory && (
          <MemoryWarning
            sizeBytes={memory.sizeBytes}
            onEdit={() => handleSelectNote('memory.md')}
          />
        )}
        <RambleApprovalModal />
        <div className="app">
        {isMobile ? (
          // Mobile layout - show one view at a time
          mobileView === 'list' ? (
            <SidebarWithRamble
              ref={sidebarRef}
              fullScreen
              onMobileBack={() => setMobileView('conversation')}
              timelineItems={timelineItems}
              activeFilter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedItemId={selectedItemId}
              onSelectItem={(item) => {
                handleSelectItem(item);
                setMobileView('conversation');
              }}
              streamingConversationIds={getStreamingConversationIds()}
              unreadConversationIds={getUnreadConversationIds()}
              availableModels={availableModels}
              onNewConversation={() => {
                handleNewConversation();
                setMobileView('conversation');
              }}
              onNewComparison={handleNewComparison}
              onNewCouncil={handleNewCouncil}
              onNewTrigger={() => setShowTriggerConfig(true)}
              onRenameConversation={handleRenameConversation}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTrigger={handleDeleteTrigger}
              onDeleteNote={handleDeleteNote}
            />
          ) : (
            // mobileView === 'conversation'
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
              onBack={() => setMobileView('list')}
            />
          )
        ) : (
          // Desktop layout - sidebar + main panel
          <>
            <SidebarWithRamble
              ref={sidebarRef}
              timelineItems={timelineItems}
              activeFilter={timelineFilter}
              onFilterChange={setTimelineFilter}
              selectedItemId={selectedItemId}
              onSelectItem={handleSelectItem}
              streamingConversationIds={getStreamingConversationIds()}
              unreadConversationIds={getUnreadConversationIds()}
              availableModels={availableModels}
              onNewConversation={handleNewConversation}
              onNewComparison={handleNewComparison}
              onNewCouncil={handleNewCouncil}
              onNewTrigger={() => setShowTriggerConfig(true)}
              onRenameConversation={handleRenameConversation}
              onDeleteConversation={handleDeleteConversation}
              onDeleteTrigger={handleDeleteTrigger}
              onDeleteNote={handleDeleteNote}
            />
      <MainPanelWithRamble
        notes={notes}
        selectedModel={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
        onNavigateToNote={handleSelectNote}
        selectedNote={selectedNote}
        hasNonRambleSelection={!!(currentConversation || selectedTrigger)}
        onClearNote={() => {
          setNoteContent(null);
          setSelectedItem(null);
        }}
      >
      <div className="main-panel">
        {selectedTrigger ? (
          <TriggerDetailView
            trigger={selectedTrigger}
            onBack={handleGoBack}
            canGoBack={navigationHistory.length > 0}
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
        ) : showComparisonSelector ? (
          <div className="main-content">
            <ComparisonModelSelector
              availableModels={availableModels}
              favoriteModels={config?.favoriteModels}
              onStartComparison={handleStartComparison}
              onCancel={() => setShowComparisonSelector(false)}
            />
          </div>
        ) : showCouncilSelector ? (
          <div className="main-content">
            <CouncilModelSelector
              availableModels={availableModels}
              favoriteModels={config?.favoriteModels}
              onStartCouncil={handleStartCouncil}
              onCancel={() => setShowCouncilSelector(false)}
            />
          </div>
        ) : selectedNote ? (
          <NoteViewerWithIntegrate
            content={selectedNote.content}
            filename={selectedNote.filename}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId: string, messageId?: string) => {
              console.log('[App] NoteViewer onNavigateToConversation callback called with:', conversationId, messageId);
              handleSelectConversation(conversationId, true, messageId);
            }}
            conversations={conversations}
            notes={notes}
            selectedModel={config?.favoriteModels?.[0] || availableModels[0]?.key || ''}
            canGoBack={navigationHistory.length > 0}
            onGoBack={handleGoBack}
          />
        ) : isCouncilConversation && currentConversation ? (
          <CouncilChatInterface
            ref={councilChatInterfaceRef}
            conversation={currentConversation}
            availableModels={availableModels}
            onUpdateConversation={handleUpdateCouncilConversation}
            memoryContent={memory?.content}
          />
        ) : isComparisonConversation && currentConversation ? (
          <ComparisonChatInterface
            ref={comparisonChatInterfaceRef}
            conversation={currentConversation}
            availableModels={availableModels}
            onUpdateConversation={handleUpdateComparisonConversation}
            memoryContent={memory?.content}
          />
        ) : (
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
            onBack={handleGoBack}
            canGoBack={navigationHistory.length > 0}
          />
        )}
      </div>
      </MainPanelWithRamble>
          </>
        )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          vaultPath={vaultService.getVaultPath()}
          onChangeVault={async () => {
            const newPath = await vaultService.selectVaultFolder();
            if (newPath) {
              await loadVault(newPath);
            }
          }}
          onConfigReload={handleConfigReload}
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
      </div>
      </RambleProvider>
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
