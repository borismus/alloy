import { useCallback, useRef } from 'react';
import { vaultService } from '../services/vault';
import { skillRegistry } from '../services/skills';
import { executeViaServer } from '../services/server-streaming';
import { generateMessageId } from '../utils/ids';
import { parseSlashCommand } from '../utils/slashCommand';
import { Conversation, Config, Message, Attachment, ToolUse } from '../types';
import { ChatInterfaceHandle } from '../components/ChatInterface';

interface UseSendMessageDeps {
  config: Config | null;
  memory: { content: string; sizeBytes: number } | null;
  markSelfWrite: (path: string) => void;
  showToast: (message: string, type?: 'info' | 'warning' | 'error') => void;
  chatInterfaceRef: React.RefObject<ChatInterfaceHandle | null>;
  setDraftConversation: React.Dispatch<React.SetStateAction<Conversation | null>>;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  setStreamingThinkingState: (convId: string, content: string, elapsedMs: number, durationMs?: number) => void;
  updateStreamingThinking: (convId: string, chunk: string) => void;
  finishStreamingThinking: (convId: string, durationMs: number) => void;
  addToolUse: (convId: string, toolUse: ToolUse) => void;
  // Sub-agent callbacks kept on the deps surface for backward compat with App.tsx;
  // server-side spawn_subagent doesn't currently fan out per-agent updates,
  // so these are no-ops at runtime.
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
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const handleSendMessage = useCallback(async (
    currentConversation: Conversation,
    content: string,
    attachments: Attachment[],
    onChunk?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const {
      config, memory, markSelfWrite, showToast, chatInterfaceRef,
      setDraftConversation, setConversations,
      setStreamingThinkingState, updateStreamingThinking, finishStreamingThinking,
      addToolUse,
    } = depsRef.current;
    if (!config) return;

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

    setDraftConversation(prev => prev?.id === updatedConversation.id ? updatedConversation : prev);
    if (isFirstMessage) {
      setConversations(prev => [updatedConversation, ...prev]);
    } else {
      setConversations(prev => prev.map(c => c.id === updatedConversation.id ? updatedConversation : c));
    }

    // Save the user message immediately so the conversation file exists
    // before the embedded server tries to append the assistant reply.
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

    const assistantMessageId = generateMessageId();

    try {
      const systemPrompt = skillRegistry.buildSystemPrompt({
        id: currentConversation.id,
        title: currentConversation.title,
      }, memory?.content);

      const convId = currentConversation.id;

      // Explicit `/skill_name` invocation: pass the skill name to the backend,
      // which appends its instructions to the system prompt. Only when it names
      // a real skill — otherwise it's just a literal message starting with "/".
      const slash = parseSlashCommand(content);
      const invokeSkill = slash && skillRegistry.getSkill(slash.name) ? slash.name : undefined;

      const serverResult = await executeViaServer(
        convId,
        assistantMessageId,
        currentConversation.model,
        updatedMessages,
        systemPrompt,
        isFirstMessage,
        content,
        {
          onChunk,
          onThinkingState: (thinking, elapsedMs, durationMs) =>
            setStreamingThinkingState(convId, thinking, elapsedMs, durationMs),
          onThinking: (thinking) => updateStreamingThinking(convId, thinking),
          onThinkingDone: (durationMs) => finishStreamingThinking(convId, durationMs),
          invokeSkill,
          onTitle: (newTitle: string) => {
            const conv = { ...updatedConversation, title: newTitle };
            setDraftConversation(prev => prev?.id === conv.id ? conv : prev);
            setConversations(prev => prev.map(c => c.id === conv.id ? conv : c));
          },
          onToolUse: (toolUse) => addToolUse(convId, toolUse),
          signal,
        },
      );

      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: serverResult.content,
        usage: serverResult.usage,
        toolUse: serverResult.toolUse,
      };

      const finalConversation: Conversation = {
        ...updatedConversation,
        title: serverResult.title || updatedConversation.title,
        messages: [...updatedMessages, assistantMessage],
        updated: new Date().toISOString(),
      };

      setDraftConversation(prev => prev?.id === finalConversation.id ? finalConversation : prev);
      setConversations(prev => prev.map(c => c.id === finalConversation.id ? finalConversation : c));
    } catch (error: any) {
      if (error?.name === 'AbortError' || signal?.aborted) {
        // The server persists whatever the turn produced (partial text + any
        // tool calls it already ran) when it's stopped. Reload from the vault
        // so the UI reflects that saved turn, rather than overwriting it with a
        // tool-less partial copy. The vault watcher backstops us if the
        // server's write lands after this reload.
        const saved = await vaultService.loadConversation(updatedConversation.id);
        if (saved) {
          setDraftConversation(prev => prev?.id === saved.id ? saved : prev);
          setConversations(prev => prev.map(c => c.id === saved.id ? saved : c));
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
      // The server persists this turn (including any tool calls) before it
      // emits the error, so reload the file and append the log to *that*.
      // Overwriting with our own copy would drop the assistant turn the server
      // just saved, leaving a dangling user message.
      const persisted = await vaultService.loadConversation(updatedConversation.id);
      const base = persisted ?? updatedConversation;
      const errorConversation: Conversation = {
        ...base,
        messages: [...base.messages, logMessage],
        updated: new Date().toISOString(),
      };
      setDraftConversation(prev => prev?.id === errorConversation.id ? errorConversation : prev);
      setConversations(prev => prev.map(c => c.id === errorConversation.id ? errorConversation : c));
      try {
        const vaultPathForSave = vaultService.getVaultPath();
        if (vaultPathForSave) {
          const filename = vaultService.generateFilename(errorConversation.id, errorConversation.title);
          markSelfWrite(`${vaultPathForSave}/conversations/${filename}`);
        }
        await vaultService.saveConversation(errorConversation);
      } catch (saveError) {
        console.error('Error saving error log (non-fatal):', saveError);
      }

      chatInterfaceRef.current?.setInputText(content);
      showToast(errorMessage, 'error');
    }
  }, []);

  const handleSaveImage = useCallback(async (conversationId: string, imageData: Uint8Array, mimeType: string): Promise<Attachment> => {
    return await vaultService.saveImage(conversationId, imageData, mimeType);
  }, []);

  const handleLoadImageAsBase64 = useCallback(async (relativePath: string): Promise<{ base64: string; mimeType: string }> => {
    const base64 = await vaultService.loadImageAsBase64(relativePath);
    const ext = relativePath.split('.').pop()?.toLowerCase() || 'png';
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { base64, mimeType };
  }, []);

  // Manual compaction needs a server endpoint; not implemented yet.
  const handleCompactNow = useCallback(async (_currentConversation: Conversation): Promise<void> => {
    depsRef.current.showToast('Manual compaction is not yet supported with the embedded server', 'warning');
  }, []);

  return { handleSendMessage, handleSaveImage, handleLoadImageAsBase64, handleCompactNow };
}
