import { useState, useEffect, useRef, useCallback } from 'react';
import { vaultService } from './services/vault';
import { providerRegistry } from './services/providers';
import { toolRegistry } from './services/tools';
import { skillRegistry } from './services/skills';
import { useVaultWatcher } from './hooks/useVaultWatcher';
import { useStreamingContext, StreamingProvider } from './contexts/StreamingContext';
import { Conversation, Config, Message, ProviderType, ModelInfo, ComparisonMetadata, Attachment, TopicMetadata, PendingTopicPrompt, ToolUse, SkillUse } from './types';
import { BUILTIN_TOOLS, ToolCall } from './types/tools';
import { ToolRound } from './services/providers/types';
import { VaultSetup } from './components/VaultSetup';
import { ChatInterface, ChatInterfaceHandle } from './components/ChatInterface';
import { ComparisonChatInterface, ComparisonChatInterfaceHandle } from './components/ComparisonChatInterface';
import { ComparisonModelSelector } from './components/ComparisonModelSelector';
import { Sidebar, SidebarHandle } from './components/Sidebar';
import { Settings } from './components/Settings';
import { Menu } from '@tauri-apps/api/menu';
import './App.css';

function AppContent() {
  const [config, setConfig] = useState<Config | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [showComparisonSelector, setShowComparisonSelector] = useState(false);
  const [pendingTopicPrompt, setPendingTopicPrompt] = useState<PendingTopicPrompt | null>(null);
  const chatInterfaceRef = useRef<ChatInterfaceHandle>(null);
  const comparisonChatInterfaceRef = useRef<ComparisonChatInterfaceHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const { stopStreaming, getStreamingConversationIds, getUnreadConversationIds, markAsRead, addToolUse } = useStreamingContext();

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


  // Use ref to avoid circular dependency with loadVault
  const loadVaultRef = useRef<((path: string) => Promise<void>) | null>(null);

  const handleConfigChanged = useCallback(async () => {
    const vaultPath = vaultService.getVaultPath();
    if (vaultPath && loadVaultRef.current) {
      await loadVaultRef.current(vaultPath);
    }
  }, []);

  const vaultPath = vaultService.getVaultPath();
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
    }
  );

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

        // Load skills from vault
        skillRegistry.setVaultPath(path);
        await skillRegistry.loadSkills();
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
                      provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

    const newConfig: Config = {
      defaultModel: provider === 'anthropic' ? 'claude-opus-4-5-20251101' :
                    provider === 'openai' ? 'gpt-4o' : '',
      [configKey]: credential,
    };

    vaultService.setVaultPath(path);
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
      updated: now.toISOString(),
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
      updated: now.toISOString(),
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

    const provider = providerRegistry.getProvider(currentConversation.provider);
    if (!provider || !provider.isInitialized()) {
      alert(`Provider ${currentConversation.provider} is not configured.`);
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
      // Build system prompt with skill descriptions (memory is loaded via skill)
      const systemPrompt = skillRegistry.buildSystemPrompt();

      const imageLoader = async (relativePath: string) => {
        return await vaultService.loadImageAsBase64(relativePath);
      };

      // Tool execution loop
      const MAX_TOOL_ITERATIONS = 10;
      const currentMessages = updatedMessages;
      let allToolUses: ToolUse[] = [];
      let finalContent = '';
      const toolHistory: ToolRound[] = [];

      const chatOptions = {
        model: currentConversation.model,
        systemPrompt,
        tools: BUILTIN_TOOLS,
        onChunk,
        onToolUse: (toolUse: ToolUse) => {
          addToolUse(currentConversation.id, toolUse);
        },
        signal,
        imageLoader,
      };

      // Initial request
      let result = await provider.sendMessage(currentMessages, chatOptions);
      finalContent = result.content;
      if (result.toolUse) {
        allToolUses = [...allToolUses, ...result.toolUse];
      }

      // Track skills used via the use_skill tool
      const skillUse: SkillUse[] = [];

      // Tool execution loop - keep going while model wants to use tools
      let iteration = 0;
      const providerWithTools = provider as any;

      while (
        iteration < MAX_TOOL_ITERATIONS &&
        result.stopReason === 'tool_use' &&
        result.toolCalls &&
        result.toolCalls.length > 0 &&
        providerWithTools.sendMessageWithToolResults
      ) {
        iteration++;

        // Check for use_skill tool calls and track them
        for (const toolCall of result.toolCalls) {
          if (toolCall.name === 'use_skill') {
            const skillName = toolCall.input.name as string;
            if (skillName && !skillUse.find(s => s.name === skillName)) {
              skillUse.push({ name: skillName });
            }
          }
        }

        // Execute each tool call
        const toolResults = await Promise.all(
          result.toolCalls.map(async (toolCall: ToolCall) => {
            const toolResult = await toolRegistry.executeTool(toolCall);

            // Update the tool use entry with result (but not for use_skill - we don't show instructions)
            if (toolCall.name !== 'use_skill') {
              const toolUseEntry = allToolUses.find(
                (t) => t.type === toolCall.name && !t.result
              );
              if (toolUseEntry) {
                toolUseEntry.result = toolResult.content.slice(0, 500); // Truncate for display
                toolUseEntry.isError = toolResult.is_error;
              }
            }

            return toolResult;
          })
        );

        // Add this round to the tool history
        toolHistory.push({
          toolCalls: result.toolCalls,
          toolResults,
        });

        // Add space separator between tool call thoughts
        onChunk?.(' ');

        // Send tool results back to the provider with full history
        result = await providerWithTools.sendMessageWithToolResults(
          currentMessages,
          toolHistory,
          chatOptions
        );

        finalContent = result.content;
        if (result.toolUse) {
          allToolUses = [...allToolUses, ...result.toolUse];
        }
      }

      // Filter out use_skill from displayed tool uses (it's shown via skillUse instead)
      const displayedToolUses = allToolUses.filter(t => t.type !== 'use_skill');

      const assistantMessage: Message = {
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: finalContent,
        toolUse: displayedToolUses.length > 0 ? displayedToolUses : undefined,
        skillUse: skillUse.length > 0 ? skillUse : undefined,
      };

      let finalConversation: Conversation = {
        ...updatedConversation,
        messages: [...updatedMessages, assistantMessage],
      };

      // Generate better title using LLM for first message
      if (isFirstMessage) {
        try {
          const betterTitle = await provider.generateTitle(content, finalContent);
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

  const handleSelectConversation = async (id: string) => {
    // Mark as read when user selects the conversation
    markAsRead(id);

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

  // Separate topics from regular conversations
  const topics = conversations.filter(c => c.topic !== undefined);
  const regularConversations = conversations.filter(c => c.topic === undefined);

  // Handle topic pill click - select the topic conversation and queue the prompt
  const handleTopicClick = (topic: Conversation) => {
    if (!topic.topic) return;

    // Select the topic conversation
    markAsRead(topic.id);
    setCurrentConversation(topic);

    // Queue the prompt to be sent once the conversation is active
    // Include targetId so ChatInterface can verify it's the right conversation
    setPendingTopicPrompt({
      prompt: topic.topic.prompt,
      targetId: topic.id,
    });
  };

  // Clear the pending prompt (called by ChatInterface after sending)
  const clearPendingTopicPrompt = () => {
    setPendingTopicPrompt(null);
  };

  // Update the lastSent timestamp for a topic (called after auto-send)
  const handleUpdateTopicLastSent = async (conversationId: string) => {
    const conversation = conversations.find(c => c.id === conversationId);
    const vaultPathForTopic = vaultService.getVaultPath();
    if (!conversation?.topic || !vaultPathForTopic) return;

    const updatedConversation: Conversation = {
      ...conversation,
      topic: {
        ...conversation.topic,
        lastSent: new Date().toISOString(),
      },
    };

    // Update state
    setConversations(prev => prev.map(c => c.id === conversationId ? updatedConversation : c));
    if (currentConversation?.id === conversationId) {
      setCurrentConversation(updatedConversation);
    }

    // Save to vault
    try {
      const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
      const filePath = `${vaultPathForTopic}/conversations/${filename}`;
      markSelfWrite(filePath);
      await vaultService.saveConversation(updatedConversation);
    } catch (error) {
      console.error('Error updating topic lastSent:', error);
    }
  };

  // Handle unpinning a topic (convert back to regular conversation)
  const handleUnpinTopic = async (conversationId: string) => {
    const conversation = conversations.find(c => c.id === conversationId);
    const vaultPathForUnpin = vaultService.getVaultPath();
    if (!conversation || !vaultPathForUnpin) return;

    // Remove the topic field
    const { topic: _, ...conversationWithoutTopic } = conversation;
    const updatedConversation: Conversation = conversationWithoutTopic;

    // Update state
    setConversations(prev => prev.map(c => c.id === conversationId ? updatedConversation : c));
    if (currentConversation?.id === conversationId) {
      setCurrentConversation(updatedConversation);
    }

    // Save to vault
    try {
      const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
      const filePath = `${vaultPathForUnpin}/conversations/${filename}`;
      markSelfWrite(filePath);
      await vaultService.saveConversation(updatedConversation);
    } catch (error) {
      console.error('Error unpinning topic:', error);
    }
  };

  // Handle making a conversation into a topic
  const handleMakeTopic = async (conversationId: string, label: string, prompt: string) => {
    const conversation = conversations.find(c => c.id === conversationId);
    const vaultPathForMakeTopic = vaultService.getVaultPath();
    if (!conversation || !vaultPathForMakeTopic) return;

    const topicMetadata: TopicMetadata = {
      label,
      prompt,
    };

    const updatedConversation: Conversation = {
      ...conversation,
      topic: topicMetadata,
    };

    // Update state
    setConversations(prev => prev.map(c => c.id === conversationId ? updatedConversation : c));
    if (currentConversation?.id === conversationId) {
      setCurrentConversation(updatedConversation);
    }

    // Save to vault
    try {
      const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
      const filePath = `${vaultPathForMakeTopic}/conversations/${filename}`;
      markSelfWrite(filePath);
      await vaultService.saveConversation(updatedConversation);
    } catch (error) {
      console.error('Error saving topic:', error);
    }
  };

  // Handle right-click on topic pill
  const handleTopicContextMenu = async (e: React.MouseEvent, topicId: string) => {
    e.preventDefault();
    try {
      const menu = await Menu.new({
        items: [
          {
            id: 'unpin',
            text: 'Unpin Topic',
            action: () => {
              handleUnpinTopic(topicId);
            }
          }
        ]
      });
      await menu.popup();
    } catch (error) {
      console.error('Failed to show topic context menu:', error);
    }
  };

  return (
    <div className="app">
      <Sidebar
        ref={sidebarRef}
        conversations={regularConversations}
        currentConversationId={currentConversation?.id || null}
        streamingConversationIds={getStreamingConversationIds()}
        unreadConversationIds={getUnreadConversationIds()}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onNewComparison={handleNewComparison}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        onMakeTopic={handleMakeTopic}
      />
      <div className="main-panel">
        {topics.length > 0 && (
          <div className="topics-bar">
            {topics.map((topic) => (
              <button
                key={topic.id}
                className={`topic-pill ${currentConversation?.id === topic.id ? 'active' : ''}`}
                onClick={() => handleTopicClick(topic)}
                onContextMenu={(e) => handleTopicContextMenu(e, topic.id)}
                title={topic.topic?.prompt}
              >
                {topic.topic?.label}
              </button>
            ))}
          </div>
        )}
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
            pendingTopicPrompt={pendingTopicPrompt}
            onClearPendingTopicPrompt={clearPendingTopicPrompt}
            onUpdateTopicLastSent={handleUpdateTopicLastSent}
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
    </div>
  );
}

function App() {
  return (
    <StreamingProvider>
      <AppContent />
    </StreamingProvider>
  );
}

export default App;
