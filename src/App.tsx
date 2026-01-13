import { useState, useEffect, useRef } from 'react';
import { vaultService } from './services/vault';
import { providerRegistry } from './services/providers';
import { Conversation, Config, Message, ProviderType, ModelInfo, ComparisonMetadata } from './types';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { ComparisonChatInterface, ComparisonChatInterfaceHandle } from './components/ComparisonChatInterface';
import { ComparisonModelSelector } from './components/ComparisonModelSelector';
import { Sidebar } from './components/Sidebar';
import { Settings } from './components/Settings';
import './App.css';

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memory, setMemory] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [memoryFilePath, setMemoryFilePath] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [showComparisonSelector, setShowComparisonSelector] = useState(false);
  const chatInterfaceRef = useRef<ChatInterfaceHandle>(null);
  const comparisonChatInterfaceRef = useRef<ComparisonChatInterfaceHandle>(null);

  useEffect(() => {
    const initializeApp = async () => {
      try {
        const savedVaultPath = localStorage.getItem('vaultPath');
        if (savedVaultPath) {
          await loadVault(savedVaultPath);
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

      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings]);

  const loadVault = async (path: string) => {
    try {
      vaultService.setVaultPath(path);
      const loadedConfig = await vaultService.loadConfig();

      if (loadedConfig) {
        setConfig(loadedConfig);
        localStorage.setItem('vaultPath', path);

        // Initialize providers from config
        await providerRegistry.initializeFromConfig(loadedConfig);
        setAvailableModels(providerRegistry.getAllAvailableModels());

        const loadedConversations = await vaultService.loadConversations();
        setConversations(loadedConversations);

        const loadedMemory = await vaultService.loadMemory();
        setMemory(loadedMemory);

        const memoryPath = await vaultService.getMemoryFilePath();
        setMemoryFilePath(memoryPath);
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

  const handleVaultSelected = async (path: string, provider: ProviderType, credential: string) => {
    // Save the provider credential to config
    const configKey = provider === 'ollama' ? 'OLLAMA_BASE_URL' :
                      provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

    const newConfig: Config = {
      vaultPath: path,
      defaultModel: provider === 'anthropic' ? 'claude-opus-4-5-20251101' :
                    provider === 'openai' ? 'gpt-4o' : '',
      [configKey]: credential,
    };

    await vaultService.saveConfig(newConfig);
    await loadVault(path);
  };

  const handleNewConversation = () => {
    const defaultProvider = providerRegistry.getDefaultProvider();
    const defaultModel = providerRegistry.getDefaultModel();

    if (!defaultProvider || !defaultModel) {
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
      provider: defaultProvider,
      model: defaultModel,
      messages: [],
    };
    setCurrentConversation(newConversation);
  };

  const handleNewComparison = () => {
    if (availableModels.length < 2) {
      alert('You need at least 2 models available to create a comparison. Please configure additional providers in Settings.');
      return;
    }
    setShowComparisonSelector(true);
  };

  const handleStartComparison = (selectedModels: ModelInfo[]) => {
    if (selectedModels.length < 2) return;

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);

    const comparisonMetadata: ComparisonMetadata = {
      isComparison: true,
      models: selectedModels.map(m => ({ provider: m.provider, model: m.id })),
    };

    const newConversation: Conversation = {
      id: `${date}-${time}-${hash}-compare`,
      created: now.toISOString(),
      provider: selectedModels[0].provider,
      model: selectedModels[0].id,
      messages: [],
      comparison: comparisonMetadata,
    };

    setCurrentConversation(newConversation);
    setShowComparisonSelector(false);
  };

  const handleUpdateComparisonConversation = async (updatedConversation: Conversation) => {
    setCurrentConversation(updatedConversation);

    // Check if this is the first message (conversation needs to be added to list)
    const existingConversation = conversations.find(c => c.id === updatedConversation.id);
    if (!existingConversation && updatedConversation.messages.length > 0) {
      setConversations(prev => [updatedConversation, ...prev]);
    }

    // Save to vault
    try {
      await vaultService.saveConversation(updatedConversation);
      const loadedConversations = await vaultService.loadConversations();
      setConversations(loadedConversations);
    } catch (error) {
      console.error('Error saving comparison conversation:', error);
    }
  };

  const handleModelChange = (model: string, provider: ProviderType) => {
    if (!currentConversation) return;

    const modelChanged = model !== currentConversation.model;
    const providerChanged = provider !== currentConversation.provider;

    if (modelChanged || providerChanged) {
      const logMessage: Message = {
        role: 'log',
        timestamp: new Date().toISOString(),
        content: providerChanged
          ? `Switched to ${provider} / ${model}`
          : `Model changed to ${model}`,
      };
      const updatedConversation: Conversation = {
        ...currentConversation,
        provider,
        model,
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

  const generateSlug = (title: string): string => {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  };

  const generateConversationId = (title: string): string => {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 5).replace(':', '');
    const hash = Math.random().toString(16).slice(2, 6);
    const slug = generateSlug(title);
    return `${date}-${time}-${hash}-${slug}`;
  };

  const handleSendMessage = async (content: string, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<void> => {
    if (!currentConversation || !config) return;

    const provider = providerRegistry.getProvider(currentConversation.provider);
    if (!provider || !provider.isInitialized()) {
      alert(`Provider ${currentConversation.provider} is not configured.`);
      return;
    }

    const userMessage: Message = {
      role: 'user',
      timestamp: new Date().toISOString(),
      content,
    };

    const updatedMessages = [...currentConversation.messages, userMessage];

    const isFirstMessage = currentConversation.messages.filter(m => m.role !== 'log').length === 0;
    const title = isFirstMessage ? generateFallbackTitle(content) : currentConversation.title;
    const conversationId = isFirstMessage && title ? generateConversationId(title) : currentConversation.id;

    const updatedConversation: Conversation = {
      ...currentConversation,
      id: conversationId,
      title,
      messages: updatedMessages,
    };

    setCurrentConversation(updatedConversation);

    if (isFirstMessage) {
      setConversations((prev) => [updatedConversation, ...prev]);
    } else if (conversationId !== currentConversation.id) {
      setConversations((prev) =>
        prev.map(c => c.id === currentConversation.id ? updatedConversation : c)
      );
    }

    try {
      const systemPrompt = memory ? `Here is my memory/context:\n\n${memory}` : undefined;

      const response = await provider.sendMessage(updatedMessages, {
        model: currentConversation.model,
        systemPrompt,
        onChunk,
        signal,
      });

      const assistantMessage: Message = {
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: response,
      };

      let finalConversation: Conversation = {
        ...updatedConversation,
        messages: [...updatedMessages, assistantMessage],
      };

      // Generate better title using LLM for first message
      if (isFirstMessage) {
        try {
          const betterTitle = await provider.generateTitle(content, response);
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

      setCurrentConversation(finalConversation);

      try {
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

      setCurrentConversation(currentConversation);
      if (isFirstMessage) {
        setConversations((prev) => prev.filter(c => c.id !== currentConversation.id));
      }
    }
  };

  const handleSelectConversation = async (id: string) => {
    const conversation = await vaultService.loadConversation(id);
    if (conversation) {
      // Ensure conversation has provider field (migration for old conversations)
      if (!conversation.provider) {
        conversation.provider = 'anthropic';
      }
      setCurrentConversation(conversation);
      setTimeout(() => {
        chatInterfaceRef.current?.focusInput();
      }, 0);
    }
  };

  const handleRenameConversation = async (oldId: string, newTitle: string) => {
    try {
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
    if (config?.vaultPath) {
      await loadVault(config.vaultPath);
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

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversation?.id || null}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onNewComparison={handleNewComparison}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
      />
      {showComparisonSelector ? (
        <div className="main-content">
          <ComparisonModelSelector
            availableModels={availableModels}
            onStartComparison={handleStartComparison}
            onCancel={() => setShowComparisonSelector(false)}
          />
        </div>
      ) : isComparisonConversation && currentConversation ? (
        <ComparisonChatInterface
          ref={comparisonChatInterfaceRef}
          conversation={currentConversation}
          availableModels={availableModels}
          memory={memory}
          onUpdateConversation={handleUpdateComparisonConversation}
        />
      ) : (
        <ChatInterface
          ref={chatInterfaceRef}
          conversation={currentConversation}
          onSendMessage={handleSendMessage}
          hasProvider={providerRegistry.hasAnyProvider()}
          onModelChange={handleModelChange}
          availableModels={availableModels}
        />
      )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          memoryFilePath={memoryFilePath}
          vaultPath={config?.vaultPath || null}
          onChangeVault={async () => {
            const newPath = await vaultService.selectVaultFolder();
            if (newPath) {
              await loadVault(newPath);
            }
          }}
          onConfigReload={handleConfigReload}
        />
      )}
    </div>
  );
}

export default App;
