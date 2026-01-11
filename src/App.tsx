import { useState, useEffect, useRef } from 'react';
import { vaultService } from './services/vault';
import { claudeService } from './services/claude';
import { Conversation, Config, Message } from './types';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
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
  const chatInterfaceRef = useRef<ChatInterfaceHandle>(null);

  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Try to load config from localStorage
        const savedVaultPath = localStorage.getItem('vaultPath');
        if (savedVaultPath) {
          await loadVault(savedVaultPath);
        } else {
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error initializing app:', error);
        // Clear invalid vault path and show setup
        localStorage.removeItem('vaultPath');
        setIsLoading(false);
      }
    };

    initializeApp();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command+N (or Ctrl+N on Windows) - New conversation
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNewConversation();
      }

      // Command+, (or Ctrl+, on Windows) - Settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      }

      // Escape - Close settings
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

        if (loadedConfig.anthropicApiKey) {
          claudeService.initialize(loadedConfig.anthropicApiKey, loadedConfig.defaultModel);
        }

        const loadedConversations = await vaultService.loadConversations();
        setConversations(loadedConversations);

        const loadedMemory = await vaultService.loadMemory();
        setMemory(loadedMemory);

        const memoryPath = await vaultService.getMemoryFilePath();
        setMemoryFilePath(memoryPath);
      } else {
        // No config found, clear vault path and show setup
        localStorage.removeItem('vaultPath');
      }
    } catch (error) {
      console.error('Error loading vault:', error);
      // Clear invalid vault path on error
      localStorage.removeItem('vaultPath');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVaultSelected = async (path: string) => {
    await loadVault(path);
  };

  const handleApiKeyUpdate = async (apiKey: string) => {
    if (config) {
      const updatedConfig = { ...config, anthropicApiKey: apiKey };
      await vaultService.saveConfig(updatedConfig);
      setConfig(updatedConfig);
      claudeService.initialize(apiKey, config.defaultModel);
    }
  };

  const handleNewConversation = () => {
    const newConversation: Conversation = {
      id: new Date().toISOString().split('T')[0] + '-' + Date.now(),
      created: new Date().toISOString(),
      model: config?.defaultModel || 'claude-opus-4-5-20251101',
      messages: [],
    };
    setCurrentConversation(newConversation);
  };

  const handleModelChange = (model: string) => {
    if (currentConversation) {
      const updatedConversation = {
        ...currentConversation,
        model,
      };
      setCurrentConversation(updatedConversation);
    }
  };

  const generateTitle = (firstMessage: string): string => {
    // Take first 50 chars of the message, truncate at word boundary
    const truncated = firstMessage.slice(0, 50);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  };

  const generateSlug = (title: string): string => {
    // Convert title to URL-friendly slug
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .slice(0, 50); // Max 50 chars
  };

  const generateConversationId = (title: string): string => {
    const date = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();
    const slug = generateSlug(title);
    return `${date}-${timestamp}-${slug}`;
  };

  const handleSendMessage = async (content: string, onChunk?: (text: string) => void): Promise<void> => {
    if (!currentConversation || !config) return;

    const userMessage: Message = {
      role: 'user',
      timestamp: new Date().toISOString(),
      content,
    };

    const updatedMessages = [...currentConversation.messages, userMessage];

    // Generate title from first message and update ID to include title slug
    const isFirstMessage = currentConversation.messages.length === 0;
    const title = isFirstMessage ? generateTitle(content) : currentConversation.title;
    const conversationId = isFirstMessage && title ? generateConversationId(title) : currentConversation.id;

    const updatedConversation = {
      ...currentConversation,
      id: conversationId,
      title,
      messages: updatedMessages,
    };

    setCurrentConversation(updatedConversation);

    // If this is a new conversation (first message), add it to the list immediately
    if (isFirstMessage) {
      setConversations((prev) => [updatedConversation, ...prev]);
    } else if (conversationId !== currentConversation.id) {
      // Update the conversation in the list if ID changed
      setConversations((prev) =>
        prev.map(c => c.id === currentConversation.id ? updatedConversation : c)
      );
    }

    try {
      // Include memory as system prompt if available
      const systemPrompt = memory ? `Here is my memory/context:\n\n${memory}` : undefined;

      const response = await claudeService.sendMessage(
        updatedMessages,
        systemPrompt,
        onChunk
      );

      const assistantMessage: Message = {
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: response,
      };

      const finalConversation = {
        ...updatedConversation,
        messages: [...updatedMessages, assistantMessage],
      };

      setCurrentConversation(finalConversation);

      try {
        await vaultService.saveConversation(finalConversation);
      } catch (saveError) {
        console.error('Error saving conversation (non-fatal):', saveError);
        // Continue even if save fails - we already have the message in state
      }

      // Update conversations list
      try {
        const loadedConversations = await vaultService.loadConversations();
        setConversations(loadedConversations);
      } catch (loadError) {
        console.error('Error loading conversations list (non-fatal):', loadError);
        // Continue - the current conversation is already in the list
      }
    } catch (error: any) {
      console.error('Error sending message:', error);

      // Show user-friendly error message
      let errorMessage = 'Error sending message. Please check your API key and try again.';

      if (error?.message?.includes('API key') || error?.message?.includes('401')) {
        errorMessage = 'Invalid API key. Please check your configuration.';
      } else if (error?.message?.includes('rate limit') || error?.message?.includes('429')) {
        errorMessage = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (error?.message?.includes('network') || error?.message?.includes('fetch') || error?.message?.includes('Failed to fetch')) {
        errorMessage = 'Network error. Please check your internet connection.';
      }

      alert(errorMessage);

      // Revert the conversation to previous state (remove the user message that failed)
      setCurrentConversation(currentConversation);
      // Also remove from list if it was just added
      if (isFirstMessage) {
        setConversations((prev) => prev.filter(c => c.id !== currentConversation.id));
      }
    }
  };

  const handleSelectConversation = async (id: string) => {
    const conversation = await vaultService.loadConversation(id);
    if (conversation) {
      setCurrentConversation(conversation);
      // Focus the input after a short delay to ensure the component has rendered
      setTimeout(() => {
        chatInterfaceRef.current?.focusInput();
      }, 0);
    }
  };

  const handleRenameConversation = async (oldId: string, newTitle: string) => {
    try {
      const updatedConversation = await vaultService.renameConversation(oldId, newTitle);
      if (updatedConversation) {
        // Update the conversations list
        setConversations((prev) =>
          prev.map((c) => (c.id === oldId ? updatedConversation : c))
        );

        // Update current conversation if it was renamed
        if (currentConversation?.id === oldId) {
          setCurrentConversation(updatedConversation);
        }
      }
    } catch (error) {
      console.error('Error renaming conversation:', error);
      alert('Failed to rename conversation. Please try again.');
    }
  };

  if (isLoading) {
    return <div className="loading">Loading...</div>;
  }

  if (!config) {
    return <VaultSetup onVaultSelected={handleVaultSelected} />;
  }

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversation?.id || null}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onRenameConversation={handleRenameConversation}
      />
      <ChatInterface
        ref={chatInterfaceRef}
        conversation={currentConversation}
        onSendMessage={handleSendMessage}
        hasApiKey={!!config.anthropicApiKey}
        onApiKeyUpdate={handleApiKeyUpdate}
        onModelChange={handleModelChange}
      />
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          memoryFilePath={memoryFilePath}
        />
      )}
    </div>
  );
}

export default App;
