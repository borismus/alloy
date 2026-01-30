import { useState, useEffect, useRef, useCallback } from 'react';
import { vaultService } from './services/vault';
import { providerRegistry } from './services/providers';
import { skillRegistry } from './services/skills';
import { rambleService } from './services/ramble';
import { useVaultWatcher } from './hooks/useVaultWatcher';
import { useStreamingContext, StreamingProvider } from './contexts/StreamingContext';
import { TriggerProvider } from './contexts/TriggerContext';
import { ApprovalProvider } from './contexts/ApprovalContext';
import { Conversation, Config, Message, ProviderType, ModelInfo, ComparisonMetadata, CouncilMetadata, Attachment, formatModelId, getProviderFromModel, getModelIdFromModel, NoteInfo, SidebarTab, Trigger } from './types';
import { useToolExecution } from './hooks/useToolExecution';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { ComparisonChatInterface, ComparisonChatInterfaceHandle } from './components/ComparisonChatInterface';
import { ComparisonModelSelector } from './components/ComparisonModelSelector';
import { CouncilModelSelector } from './components/CouncilModelSelector';
import { CouncilChatInterface, CouncilChatInterfaceHandle } from './components/CouncilChatInterface';
import { Sidebar, SidebarHandle } from './components/Sidebar';
import { Settings } from './components/Settings';
import { TriggerConfigModal } from './components/TriggerConfigModal';
import { TriggerManagementView } from './components/TriggerManagementView';
import { NoteViewer } from './components/NoteViewer';
import { NoteChatSidebar } from './components/NoteChatSidebar';
import { UpdateChecker } from './components/UpdateChecker';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { isBrowser, DEMO_VAULT_PATH } from './mocks';
import './App.css';

function AppContent() {
  const [config, setConfig] = useState<Config | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [showComparisonSelector, setShowComparisonSelector] = useState(false);
  const [showCouncilSelector, setShowCouncilSelector] = useState(false);
  const [showTriggerConfig, setShowTriggerConfig] = useState(false);
  const [showTriggerManagementView, setShowTriggerManagementView] = useState(false);
  const [editingTriggerConversation, setEditingTriggerConversation] = useState<Conversation | null>(null);
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chats');
  const [selectedNote, setSelectedNote] = useState<{ filename: string; content: string } | null>(null);
  // Navigation history for back button support
  type NavigationEntry =
    | { type: 'note'; filename: string; content: string }
    | { type: 'conversation'; id: string };
  const [navigationHistory, setNavigationHistory] = useState<NavigationEntry[]>([]);
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
    setCurrentConversation(prev => prev?.id === id ? null : prev);
  }, []);

  const handleConversationModified = useCallback(async (id: string) => {
    const updated = await vaultService.loadConversation(id);
    if (!updated) return;

    setConversations(prev =>
      prev.map(c => c.id === id ? updated : c)
    );

    setCurrentConversation(prev => prev?.id === id ? updated : prev);
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
        // Merge trigger config: preserve user-edited config, apply scheduler's runtime fields
        trigger: {
          ...fresh.trigger, // Preserve config: prompts, models, interval, enabled
          lastChecked: updatedTrigger.trigger.lastChecked,
          lastTriggered: updatedTrigger.trigger.lastTriggered,
          history: updatedTrigger.trigger.history,
        },
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
      onNoteModified: handleNoteChanged,
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
        } else if (isBrowser()) {
          // Browser-only mode: auto-load demo vault
          console.log('[App] Browser mode detected, loading demo vault');
          await loadVault(DEMO_VAULT_PATH);
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
    setCurrentConversation(newConversation);
  };

  const handleSelectNote = async (filename: string, addToHistory = true) => {
    const vaultPathStr = vaultService.getVaultPath();
    const notesPath = vaultService.getNotesPath();
    if (vaultPathStr && notesPath) {
      // Don't navigate to the same note we're already viewing
      if (selectedNote?.filename === filename) {
        return;
      }

      // memory.md is at vault root, other notes are in notes/
      const notePath = filename === 'memory.md'
        ? `${vaultPathStr}/${filename}`
        : `${notesPath}/${filename}`;
      try {
        const content = await readTextFile(notePath);
        // Push current view to history before navigating
        if (addToHistory) {
          if (selectedNote) {
            setNavigationHistory(prev => [...prev, { type: 'note', filename: selectedNote.filename, content: selectedNote.content }]);
          } else if (currentConversation) {
            setNavigationHistory(prev => [...prev, { type: 'conversation', id: currentConversation.id }]);
          }
        }
        // Clear conversation selection and switch to notes tab
        setCurrentConversation(null);
        setSidebarTab('notes');
        setSelectedNote({ filename, content });
      } catch (error) {
        console.error('Failed to load note:', error);
      }
    }
  };

  const handleNewNotesChat = () => {
    handleNewConversation();
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

    setCurrentConversation(newConversation);
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

    setCurrentConversation(newConversation);
    setShowCouncilSelector(false);
  };

  const handleUpdateCouncilConversation = async (updatedConversation: Conversation) => {
    setCurrentConversation(updatedConversation);

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
          // Preserve trigger config if it exists (shouldn't for council, but defensive)
          trigger: fresh.trigger ? { ...fresh.trigger, ...updatedConversation.trigger } : updatedConversation.trigger,
        }));
      }
      const loadedConversations = await vaultService.loadConversations();
      setConversations(loadedConversations);
    } catch (error) {
      console.error('Error saving council conversation:', error);
    }
  };

  const handleUpdateComparisonConversation = async (updatedConversation: Conversation) => {
    setCurrentConversation(updatedConversation);

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
          // Preserve trigger config if it exists (shouldn't for comparison, but defensive)
          trigger: fresh.trigger ? { ...fresh.trigger, ...updatedConversation.trigger } : updatedConversation.trigger,
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
      setCurrentConversation(updatedConversation);
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

    setCurrentConversation(updatedConversation);

    if (isFirstMessage) {
      setConversations((prev) => [updatedConversation, ...prev]);
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
      // Build system prompt with skill descriptions and conversation context
      const systemPrompt = skillRegistry.buildSystemPrompt({
        id: currentConversation.id,
        title: currentConversation.title,
      });

      const imageLoader = async (relativePath: string) => {
        return await vaultService.loadImageAsBase64(relativePath);
      };

      // Execute with tool loop support
      const result = await executeWithTools(provider, updatedMessages, modelId, {
        maxIterations: 10,
        onChunk,
        onToolUse: (toolUse) => addToolUse(currentConversation.id, toolUse),
        signal,
        imageLoader,
        systemPrompt,
      });

      const assistantMessage: Message = {
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

      // Only update current conversation if user is still viewing it
      setCurrentConversation((prev) =>
        prev?.id === finalConversation.id ? finalConversation : prev
      );

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
      setCurrentConversation((prev) =>
        prev?.id === currentConversation.id ? currentConversation : prev
      );
      if (isFirstMessage) {
        setConversations((prev) => prev.filter(c => c.id !== currentConversation.id));
      }
    }
  };

  const handleSelectConversation = async (id: string, addToHistory = true) => {
    console.log('[App] handleSelectConversation called with id:', id);

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

    // Close any open selectors/views and clear note selection
    setShowTriggerManagementView(false);
    setShowComparisonSelector(false);
    setShowCouncilSelector(false);
    setSelectedNote(null);
    setSidebarTab('chats');

    // First try loading as a regular conversation
    let conversation = await vaultService.loadConversation(id);

    // If not found, try loading as a trigger (triggers are in triggers/ directory)
    if (!conversation) {
      const trigger = await vaultService.loadTrigger(id);
      if (trigger) {
        // Cast trigger to Conversation for display
        conversation = trigger as unknown as Conversation;
      }
    }

    console.log('[App] Loaded conversation:', conversation ? conversation.id : 'NOT FOUND');
    if (conversation) {
      // Migration is now handled in vault.ts migrateConversationFormat
      setCurrentConversation(conversation);
      setTimeout(() => {
        chatInterfaceRef.current?.focusInput();
      }, 0);
    }
  };

  const handleGoBack = async () => {
    if (navigationHistory.length === 0) return;

    const previousEntry = navigationHistory[navigationHistory.length - 1];
    setNavigationHistory(prev => prev.slice(0, -1));

    if (previousEntry.type === 'note') {
      // Navigate back to note without adding to history
      setCurrentConversation(null);
      setSidebarTab('notes');
      setSelectedNote({ filename: previousEntry.filename, content: previousEntry.content });
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

        if (currentConversation?.id === oldId) {
          setCurrentConversation(updatedConversation);
        }
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

        if (currentConversation?.id === id) {
          setCurrentConversation(null);
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

  // Triggers are now loaded separately from conversations
  const regularConversations = conversations;

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

  // Handle updating a trigger on an existing conversation
  const handleUpdateTrigger = async (conversationId: string, config: import('./types').TriggerConfig) => {
    const vaultPathForUpdate = vaultService.getVaultPath();
    if (!vaultPathForUpdate) return;

    try {
      // Atomic read-modify-write to avoid race conditions
      const updated = await vaultService.updateConversation(conversationId, (fresh) => ({
        ...fresh,
        trigger: config,
      }));

      if (updated) {
        const filename = vaultService.generateFilename(updated.id, updated.title);
        const filePath = `${vaultPathForUpdate}/conversations/${filename}`;
        markSelfWrite(filePath);

        // Update state with the result
        setConversations(prev => prev.map(c => c.id === conversationId ? updated : c));
        if (currentConversation?.id === conversationId) {
          setCurrentConversation(updated);
        }
      }
    } catch (error) {
      console.error('Error updating trigger:', error);
    }
  };

  // Handle creating a new triggered conversation
  const handleCreateTrigger = async (config: import('./types').TriggerConfig, title?: string) => {
    const vaultPathForCreate = vaultService.getVaultPath();
    if (!vaultPathForCreate) return;

    // Generate conversation ID
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);

    // Seed the conversation with the baseline message (the trigger prompt)
    const baselineMessage: import('./types').Message = {
      role: 'user',
      timestamp: now.toISOString(),
      content: config.triggerPrompt,
    };

    // Create a new conversation with the trigger
    // The model is already in unified format from TriggerConfig
    const newConversation: Conversation = {
      id: `${date}-${time}-${hash}`,
      created: now.toISOString(),
      updated: now.toISOString(),
      model: config.model,  // Already in "provider/model" format
      title: title || 'Triggered Conversation',
      messages: [baselineMessage],
      trigger: config,
    };

    // Save to vault
    try {
      const filename = vaultService.generateFilename(newConversation.id, newConversation.title);
      const filePath = `${vaultPathForCreate}/conversations/${filename}`;
      markSelfWrite(filePath);
      await vaultService.saveConversation(newConversation);

      // Update state
      setConversations(prev => [newConversation, ...prev]);
      setCurrentConversation(newConversation);
    } catch (error) {
      console.error('Error creating triggered conversation:', error);
    }
  };

  return (
    <TriggerProvider
      getTriggers={getTriggers}
      onTriggerUpdated={handleTriggerUpdated}
      vaultPath={vaultPath}
    >
      <UpdateChecker />
      <div className="app">
        <Sidebar
          ref={sidebarRef}
          conversations={regularConversations}
          triggers={triggers}
          currentConversationId={currentConversation?.id || null}
          streamingConversationIds={getStreamingConversationIds()}
          unreadConversationIds={getUnreadConversationIds()}
          availableModels={availableModels}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onNewComparison={handleNewComparison}
          onNewCouncil={handleNewCouncil}
          onNewTrigger={() => setShowTriggerConfig(true)}
          onRenameConversation={handleRenameConversation}
          onDeleteConversation={handleDeleteConversation}
          onDeleteTrigger={handleDeleteTrigger}
          onOpenTriggerManagement={() => setShowTriggerManagementView(true)}
          notes={notes}
          activeTab={sidebarTab}
          selectedNoteFilename={selectedNote?.filename || null}
          onSelectNote={handleSelectNote}
          onNewNotesChat={handleNewNotesChat}
          onTabChange={setSidebarTab}
          canGoBack={navigationHistory.length > 0}
          onGoBack={handleGoBack}
        />
      <div className="main-panel">
        {showTriggerManagementView ? (
          <div className="main-content">
            <TriggerManagementView
              triggers={triggers}
              onNewTrigger={() => {
                setShowTriggerManagementView(false);
                setEditingTriggerConversation(null);
                setShowTriggerConfig(true);
              }}
              onEditTrigger={(trigger) => {
                setShowTriggerManagementView(false);
                // Convert trigger to conversation-like shape for editing
                setEditingTriggerConversation(trigger as unknown as Conversation);
                setShowTriggerConfig(true);
              }}
              onDeleteTrigger={handleDeleteTrigger}
              onSelectTrigger={() => {
                // TODO: Open trigger view
                setShowTriggerManagementView(false);
              }}
            />
          </div>
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
          <NoteViewer
            content={selectedNote.content}
            onNavigateToNote={handleSelectNote}
            onNavigateToConversation={(conversationId) => {
              console.log('[App] NoteViewer onNavigateToConversation callback called with:', conversationId);
              handleSelectConversation(conversationId);
            }}
            conversations={conversations}
          />
        ) : isCouncilConversation && currentConversation ? (
          <CouncilChatInterface
            ref={councilChatInterfaceRef}
            conversation={currentConversation}
            availableModels={availableModels}
            onUpdateConversation={handleUpdateCouncilConversation}
          />
        ) : isComparisonConversation && currentConversation ? (
          <ComparisonChatInterface
            ref={comparisonChatInterfaceRef}
            conversation={currentConversation}
            availableModels={availableModels}
            onUpdateConversation={handleUpdateComparisonConversation}
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
            onNavigateToNote={(noteFilename) => {
              // Switch to notes tab and open the note
              setSidebarTab('notes');
              handleSelectNote(noteFilename);
            }}
            onNavigateToConversation={handleSelectConversation}
          />
        )}
      </div>
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
          conversation={editingTriggerConversation}
          availableModels={availableModels}
          favoriteModels={config?.favoriteModels}
          onSave={async (newTriggerConfig, title) => {
            const wasEditing = !!editingTriggerConversation;
            if (editingTriggerConversation) {
              // Editing existing trigger
              await handleUpdateTrigger(editingTriggerConversation.id, newTriggerConfig);
            } else {
              // Creating new trigger
              await handleCreateTrigger(newTriggerConfig, title);
            }
            setEditingTriggerConversation(null);
            setShowTriggerConfig(false);
            // If we were editing, return to the management view
            if (wasEditing) {
              setShowTriggerManagementView(true);
            }
          }}
          onClose={() => {
            setShowTriggerConfig(false);
            // If we were editing, return to the management view
            if (editingTriggerConversation) {
              setShowTriggerManagementView(true);
            }
            setEditingTriggerConversation(null);
          }}
        />
      )}
        {selectedNote && (
          <NoteChatSidebar isOpen={true} availableModels={availableModels} favoriteModels={config?.favoriteModels} onNavigateToNote={handleSelectNote} />
        )}
      </div>
    </TriggerProvider>
  );
}

function App() {
  return (
    <StreamingProvider>
      <ApprovalProvider>
        <AppContent />
      </ApprovalProvider>
    </StreamingProvider>
  );
}

export default App;
