import React, { useState, useEffect, useRef, KeyboardEvent, useCallback, useImperativeHandle } from 'react';
import { rambleService } from '../services/ramble';
import { providerRegistry } from '../services/providers';
import { useToolExecution } from '../hooks/useToolExecution';
import { useConversationStreaming } from '../hooks/useConversationStreaming';
import { Message, ModelInfo, getModelIdFromModel } from '../types';
import { BUILTIN_TOOLS } from '../types/tools';
import { ConversationView, ConversationViewHandle } from './ConversationView';
import { ModelSelector } from './ModelSelector';
import './NoteChatSidebar.css';

// Filter to only note-focused tools
const NOTE_CHAT_TOOLS = BUILTIN_TOOLS.filter(t =>
  ['read_file', 'write_file', 'append_to_note', 'list_directory', 'use_skill'].includes(t.name)
);

// System prompt focused on note-taking
const NOTE_CHAT_SYSTEM_PROMPT = `You are a quiet note-taking companion. Listen as the user thinks aloud and capture valuable insights into their notes.

## Your Tools

- read_file: Read existing notes to understand context
- append_to_note: Quietly add insights, ideas, to-dos (provenance tracked automatically)
- write_file: Rewrite entire note content (requires user approval)
- list_directory: See what notes exist
- use_skill: Use a skill (e.g., "summarize-note" to compress a cluttered note)

## Available Skills

- **summarize-note**: Compress a note significantly while preserving provenance markers

## Your Behavior

1. Listen actively - Pay attention to what the user is talking about
2. Capture quietly - Use append_to_note when you hear:
   - Ideas or insights
   - To-dos or action items
   - Decisions or conclusions
   - Questions to explore later
3. Stay minimal - Don't over-capture. Focus on the valuable bits.
4. Be brief - Keep responses to 1-2 sentences. Let the user do the talking.
5. Don't explain what you captured unless asked
6. Don't ask for permission before appending (that's the point - it's quiet)
7. When a note gets cluttered, offer to use the summarize-note skill

## Provenance

Every line you append gets a marker like \`&[[chat^msg-a1b2]]\` linking it to this conversation.
This allows later compaction to distinguish AI vs human content.
You do NOT add these markers yourself - they are added automatically.`;

// Generate unique message ID
const generateMessageId = () => `msg-${Math.random().toString(16).slice(2, 6)}`;

interface NoteChatSidebarProps {
  isOpen: boolean;
  availableModels: ModelInfo[];
  favoriteModels?: string[];
  onNavigateToNote?: (noteFilename: string) => void;
}

export interface NoteChatSidebarHandle {
  scrollToMessage: (messageId: string) => void;
}

const RAMBLE_CONVERSATION_ID = 'ramble_history';

export const NoteChatSidebar = React.forwardRef<NoteChatSidebarHandle, NoteChatSidebarProps>(({ isOpen, availableModels, favoriteModels, onNavigateToNote }, ref) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<ConversationViewHandle>(null);
  const { execute: executeWithTools } = useToolExecution();

  // Use shared streaming context (same as ChatInterface)
  const {
    isStreaming,
    streamingContent,
    streamingToolUse,
    start: startStreaming,
    stop: stopStreaming,
    updateContent,
    addToolUse,
    complete: completeStreaming,
    clear: clearStreaming,
  } = useConversationStreaming(RAMBLE_CONVERSATION_ID);

  // Initialize model selection
  useEffect(() => {
    if (!selectedModel && availableModels.length > 0) {
      // Prefer first favorite, otherwise first available
      if (favoriteModels && favoriteModels.length > 0) {
        setSelectedModel(favoriteModels[0]);
      } else {
        setSelectedModel(availableModels[0].key);
      }
    }
  }, [availableModels, favoriteModels, selectedModel]);

  // Load history on mount
  useEffect(() => {
    const loadHistory = async () => {
      const history = await rambleService.loadHistory();
      setMessages(history);
      // Scroll to bottom after history loads
      setTimeout(() => conversationRef.current?.scrollToBottom(), 0);
    };
    loadHistory();
  }, []);

  // Focus textarea and scroll to bottom when panel opens
  useEffect(() => {
    if (isOpen) {
      textareaRef.current?.focus();
      setTimeout(() => conversationRef.current?.scrollToBottom(), 0);
    }
  }, [isOpen]);

  // Clear streaming content once the assistant message appears in history
  const lastMessage = messages[messages.length - 1];
  const hasCompletedContent = !isStreaming && !!streamingContent;
  useEffect(() => {
    if (hasCompletedContent && lastMessage?.role === 'assistant') {
      clearStreaming();
    }
  }, [hasCompletedContent, lastMessage?.role, clearStreaming]);

  // Expose scrollToMessage via ref
  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string) => {
      conversationRef.current?.scrollToMessage(messageId);
    },
  }), []);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
  };

  const handleStop = useCallback(() => {
    stopStreaming();
  }, [stopStreaming]);

  const handleSend = async () => {
    if (!inputValue.trim() || isStreaming || !selectedModel) return;

    const [providerType] = selectedModel.split('/') as [string, string];
    const modelId = getModelIdFromModel(selectedModel);

    const provider = providerRegistry.getProvider(providerType as any);
    if (!provider || !provider.isInitialized()) {
      console.error('[NoteChat] Provider not initialized:', providerType);
      return;
    }

    // Create user message
    const userMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      timestamp: new Date().toISOString(),
      content: inputValue.trim(),
    };

    // Add to UI, clear input, and start streaming
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Save history in background (don't block UI)
    rambleService.saveHistory(updatedMessages);

    // Start streaming (returns AbortController)
    const abortController = startStreaming();
    if (!abortController) return;

    // Generate message ID for provenance tracking
    const messageId = generateMessageId();

    try {
      const result = await executeWithTools(provider, updatedMessages, modelId, {
        maxIterations: 10,
        tools: NOTE_CHAT_TOOLS,
        toolContext: {
          messageId,
          conversationId: 'ramble_history',
          requireWriteApproval: true,
        },
        onChunk: (chunk) => {
          updateContent(chunk);
        },
        onToolUse: (toolUse) => {
          addToolUse(toolUse);
        },
        signal: abortController.signal,
        systemPrompt: NOTE_CHAT_SYSTEM_PROMPT,
      });

      // Create assistant message
      const assistantMessage: Message = {
        id: messageId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: result.finalContent,
        toolUse: result.allToolUses.length > 0 ? result.allToolUses : undefined,
      };

      // Add to history
      const finalMessages = [...updatedMessages, assistantMessage];
      setMessages(finalMessages);
      await rambleService.saveHistory(finalMessages);

      completeStreaming();
    } catch (error: any) {
      completeStreaming();
      if (error?.name === 'AbortError') {
        // User cancelled - save partial if any
        if (streamingContent) {
          const partialMessage: Message = {
            role: 'assistant',
            timestamp: new Date().toISOString(),
            content: streamingContent + '\n\n[cancelled]',
            toolUse: streamingToolUse.length > 0 ? streamingToolUse : undefined,
          };
          const finalMessages = [...updatedMessages, partialMessage];
          setMessages(finalMessages);
          await rambleService.saveHistory(finalMessages);
        }
      } else {
        console.error('[NoteChat] Error:', error);
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send, modifier+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      handleSend();
    }
    // Escape to cancel
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleStop();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="note-chat-sidebar">
      <ConversationView
        ref={conversationRef}
        messages={messages}
        streamingContent={streamingContent}
        streamingToolUse={streamingToolUse}
        isStreaming={isStreaming}
        showHeader={false}
        compact={true}
        className="note-chat-conversation"
        onNavigateToNote={onNavigateToNote}
        emptyState={
          <div className="note-chat-empty">
            <p>Note Chat</p>
            <p className="hint">Talk to your notes, add thoughts</p>
          </div>
        }
      />

      <div className="note-chat-input-area">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Chat with your notes..."
          className="note-chat-textarea"
          rows={3}
          disabled={isStreaming}
        />
        <div className="note-chat-input-controls">
          <ModelSelector
            value={selectedModel}
            onChange={setSelectedModel}
            disabled={isStreaming}
            models={availableModels}
            favoriteModels={favoriteModels}
          />
          {isStreaming ? (
            <button
              className="note-chat-send-btn note-chat-stop-btn"
              onClick={handleStop}
              title="Stop (Esc)"
            >
              Stop
            </button>
          ) : (
            <button
              className="note-chat-send-btn"
              onClick={handleSend}
              disabled={!inputValue.trim() || !selectedModel}
              title="Send (Enter)"
            >
              Go
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
