import { useCallback, useRef } from 'react';
import { vaultService } from '../services/vault';
import { providerRegistry } from '../services/providers';
import { skillRegistry } from '../services/skills';
import { compressImageToFit, mimeTypeFromPath } from '../services/imageUtils';
import { estimateCost } from '../services/pricing';
import { shouldCompact, compactConversation } from '../services/context';
import { isServerMode } from '../mocks';
import { executeViaServer } from '../services/server-streaming';
import { generateMessageId } from '../utils/ids';
import { useToolExecution } from './useToolExecution';
import { Conversation, Config, Message, Attachment, Usage, ToolUse, getProviderFromModel, getModelIdFromModel } from '../types';
import { ChatInterfaceHandle } from '../components/ChatInterface';

interface UseSendMessageDeps {
  config: Config | null;
  memory: { content: string; sizeBytes: number } | null;
  markSelfWrite: (path: string) => void;
  showToast: (message: string, type?: 'info' | 'warning' | 'error') => void;
  chatInterfaceRef: React.RefObject<ChatInterfaceHandle | null>;
  setDraftConversation: React.Dispatch<React.SetStateAction<Conversation | null>>;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  // Streaming callbacks
  addToolUse: (convId: string, toolUse: ToolUse) => void;
  startSubagents: (convId: string, agents: { id: string; name: string; model: string; prompt: string }[]) => void;
  updateSubagentContent: (convId: string, agentId: string, chunk: string) => void;
  addSubagentToolUse: (convId: string, agentId: string, toolUse: ToolUse) => void;
  completeSubagent: (convId: string, agentId: string, error?: string) => void;
}

function generateFallbackTitle(firstMessage: string): string {
  const truncated = firstMessage.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
}

export function useSendMessage(deps: UseSendMessageDeps) {
  const { execute: executeWithTools } = useToolExecution();
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const handleSendMessage = useCallback(async (
    currentConversation: Conversation,
    content: string,
    attachments: Attachment[],
    onChunk?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const { config, memory, markSelfWrite, showToast, chatInterfaceRef, setDraftConversation, setConversations } = depsRef.current;
    if (!config) return;

    const providerType = getProviderFromModel(currentConversation.model);
    const modelId = getModelIdFromModel(currentConversation.model);
    const provider = providerRegistry.getProvider(providerType);

    if (!isServerMode() && (!provider || !provider.isInitialized())) {
      showToast(`Provider ${providerType} is not configured.`, 'error');
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

    const updatedConversation: Conversation = {
      ...currentConversation,
      title,
      messages: updatedMessages,
      updated: new Date().toISOString(),
    };

    // Update state immediately
    setDraftConversation(prev => prev?.id === updatedConversation.id ? updatedConversation : prev);
    if (isFirstMessage) {
      setConversations(prev => [updatedConversation, ...prev]);
    } else {
      setConversations(prev => prev.map(c => c.id === updatedConversation.id ? updatedConversation : c));
    }

    // Save user message immediately
    try {
      const vaultPathForSave = vaultService.getVaultPath();
      const filename = vaultService.generateFilename(updatedConversation.id, updatedConversation.title);
      if (vaultPathForSave) {
        const filePath = `${vaultPathForSave}/conversations/${filename}`;
        markSelfWrite(filePath);
        const oldFilePath = await vaultService.getConversationFilePath(updatedConversation.id);
        if (oldFilePath) markSelfWrite(oldFilePath);
      }
      await vaultService.saveConversation(updatedConversation);
    } catch (saveError) {
      console.error('Error saving conversation on user message (non-fatal):', saveError);
    }

    let accumulatedContent = '';
    const assistantMessageId = generateMessageId();

    const savePartialConversation = async (partialContent: string) => {
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: partialContent,
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
          markSelfWrite(`${vaultPathForSave}/conversations/${filename}`);
        }
        await vaultService.saveConversation(finalConv);
      } catch (saveError) {
        console.error('Error saving partial conversation (non-fatal):', saveError);
      }
    };

    try {
      const systemPrompt = skillRegistry.buildSystemPrompt({
        id: currentConversation.id,
        title: currentConversation.title,
      }, memory?.content);

      const convId = currentConversation.id;

      if (isServerMode()) {
        const serverResult = await executeViaServer(
          convId,
          assistantMessageId,
          currentConversation.model,
          updatedMessages,
          systemPrompt,
          isFirstMessage,
          content,
          {
            onChunk: onChunk ? (chunk: string) => {
              accumulatedContent += chunk;
              onChunk(chunk);
            } : undefined,
            onTitle: (newTitle: string) => {
              const conv = { ...updatedConversation, title: newTitle };
              setDraftConversation(prev => prev?.id === conv.id ? conv : prev);
              setConversations(prev => prev.map(c => c.id === conv.id ? conv : c));
            },
            signal,
          },
        );

        const assistantMessage: Message = {
          id: assistantMessageId,
          role: 'assistant',
          timestamp: new Date().toISOString(),
          content: serverResult.content,
          usage: serverResult.usage,
        };

        const finalConversation: Conversation = {
          ...updatedConversation,
          title: serverResult.title || updatedConversation.title,
          messages: [...updatedMessages, assistantMessage],
          updated: new Date().toISOString(),
        };

        setDraftConversation(prev => prev?.id === finalConversation.id ? finalConversation : prev);
        setConversations(prev => prev.map(c => c.id === finalConversation.id ? finalConversation : c));

      } else {
        if (!provider || !provider.isInitialized()) {
          showToast(`Provider ${providerType} is not configured.`, 'error');
          return;
        }

        const { addToolUse, startSubagents, updateSubagentContent, addSubagentToolUse, completeSubagent } = depsRef.current;

        const imageLoader = async (relativePath: string) => {
          const data = await vaultService.loadImageAsBase64(relativePath);
          const mimeType = mimeTypeFromPath(relativePath);
          return await compressImageToFit(data, mimeType);
        };

        // Check if LLM-based context compaction is needed
        let messagesToSend = updatedMessages;
        const contextWindow = providerRegistry.getContextWindow(currentConversation.model);
        if (contextWindow) {
          // Use ~50% of context window as the message budget threshold
          const messageBudget = Math.floor(contextWindow * 0.5);
          if (shouldCompact(messagesToSend, messageBudget)) {
            try {
              const compactionResult = await compactConversation(messagesToSend, modelId, provider);
              if (compactionResult.compactedCount > 0) {
                messagesToSend = compactionResult.messages;
                // Update conversation state with compacted messages
                const compactedConv: Conversation = {
                  ...updatedConversation,
                  messages: messagesToSend,
                  updated: new Date().toISOString(),
                };
                setDraftConversation(prev => prev?.id === compactedConv.id ? compactedConv : prev);
                setConversations(prev => prev.map(c => c.id === compactedConv.id ? compactedConv : c));
                await vaultService.saveConversation(compactedConv);
              }
            } catch (e) {
              console.error('Context compaction failed (non-fatal):', e);
            }
          }
        }

        const result = await executeWithTools(provider, messagesToSend, modelId, {
          maxIterations: 10,
          contextWindow: providerRegistry.getContextWindow(currentConversation.model),
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
          onSubagentStart: (agents) => startSubagents(convId, agents),
          onSubagentChunk: (agentId, chunk) => updateSubagentContent(convId, agentId, chunk),
          onSubagentToolUse: (agentId, toolUse) => addSubagentToolUse(convId, agentId, toolUse),
          onSubagentComplete: (agentId, _content, error) => completeSubagent(convId, agentId, error),
        });

        if (signal?.aborted && accumulatedContent.trim()) {
          await savePartialConversation(accumulatedContent);
          return;
        }

        let usage: Usage | undefined;
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

        if (isFirstMessage) {
          try {
            const betterTitle = await provider.generateTitle(content, result.finalContent);
            if (betterTitle && betterTitle !== finalConversation.title) {
              finalConversation = { ...finalConversation, title: betterTitle };
            }
          } catch (titleError) {
            console.error('Failed to generate title (non-fatal):', titleError);
          }
        }

        setDraftConversation(prev => prev?.id === finalConversation.id ? finalConversation : prev);
        setConversations(prev => prev.map(c => c.id === finalConversation.id ? finalConversation : c));

        try {
          const vaultPathForFinal = vaultService.getVaultPath();
          const filename = vaultService.generateFilename(finalConversation.id, finalConversation.title);
          if (vaultPathForFinal) {
            const filePath = `${vaultPathForFinal}/conversations/${filename}`;
            markSelfWrite(filePath);
            const oldFilePath = await vaultService.getConversationFilePath(finalConversation.id);
            if (oldFilePath) markSelfWrite(oldFilePath);
          }
          await vaultService.saveConversation(finalConversation);
        } catch (saveError) {
          console.error('Error saving conversation (non-fatal):', saveError);
        }
      }

    } catch (error: any) {
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

      const logMessage: Message = {
        id: generateMessageId(),
        role: 'log',
        timestamp: new Date().toISOString(),
        content: `Error: ${error?.message || errorMessage}`,
      };
      const errorConversation: Conversation = {
        ...updatedConversation,
        messages: [...updatedConversation.messages, logMessage],
        updated: new Date().toISOString(),
      };
      setDraftConversation(prev => prev?.id === errorConversation.id ? errorConversation : prev);
      setConversations(prev => prev.map(c => c.id === errorConversation.id ? errorConversation : c));
      try {
        await vaultService.saveConversation(errorConversation);
      } catch (saveError) {
        console.error('Error saving error log (non-fatal):', saveError);
      }

      chatInterfaceRef.current?.setInputText(content);
      showToast(errorMessage, 'error');
    }
  }, [executeWithTools]);

  const handleSaveImage = useCallback(async (conversationId: string, imageData: Uint8Array, mimeType: string): Promise<Attachment> => {
    return await vaultService.saveImage(conversationId, imageData, mimeType);
  }, []);

  const handleLoadImageAsBase64 = useCallback(async (relativePath: string): Promise<{ base64: string; mimeType: string }> => {
    const base64 = await vaultService.loadImageAsBase64(relativePath);
    const ext = relativePath.split('.').pop()?.toLowerCase() || 'png';
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { base64, mimeType };
  }, []);

  return { handleSendMessage, handleSaveImage, handleLoadImageAsBase64 };
}
