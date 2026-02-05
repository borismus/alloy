import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Conversation, Message, ModelInfo, ProviderType, Attachment, getProviderFromModel, getModelIdFromModel } from '../types';
import { useConversationStreaming } from '../hooks/useConversationStreaming';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
import { ModelSelector } from './ModelSelector';
import { FindInConversation, FindInConversationHandle } from './FindInConversation';
import { AgentResponseView } from './AgentResponseView';
import { ItemHeader } from './ItemHeader';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import './ChatInterface.css';
import 'highlight.js/styles/github-dark.css';

// Hoist plugin arrays to avoid recreation on each render
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

interface UserMessageProps {
  message: Message;
  getImageUrl: (path: string) => string | undefined;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
}

// UserMessage handles user messages with image attachments
const UserMessage = React.memo(({ message, getImageUrl, onNavigateToNote, onNavigateToConversation }: UserMessageProps) => {
  const processedContent = useMemo(() => processWikiLinks(message.content), [message.content]);
  const markdownComponents = useMemo(
    () => createMarkdownComponents({ onNavigateToNote, onNavigateToConversation }),
    [onNavigateToNote, onNavigateToConversation]
  );

  return (
    <div className="message user">
      <div className="message-content">
        {message.attachments?.filter(a => a.type === 'image').map((attachment) => {
          const url = getImageUrl(attachment.path);
          return (
            <div key={attachment.path} className="message-image">
              {url && <img src={url} alt="Attachment" />}
            </div>
          );
        })}
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
          {processedContent}
        </ReactMarkdown>
      </div>
    </div>
  );
});

// LogMessage handles system log messages
const LogMessage = React.memo(({ message }: { message: Message }) => (
  <div className="message log">
    <div className="log-content">{message.content}</div>
  </div>
));

export interface PendingImage {
  data: Uint8Array;
  mimeType: string;
  preview: string;
}

interface ChatInputFormProps {
  onSubmit: (message: string, pendingImages: PendingImage[]) => Promise<void>;
  onStop: () => void;
  isStreaming: boolean;
  model: string;
  onModelChange: (modelKey: string) => void;
  availableModels: ModelInfo[];
  favoriteModels?: string[];
}

export interface ChatInputFormHandle {
  focus: () => void;
  addImages: (images: PendingImage[]) => void;
}

// Separate component for input form to isolate re-renders during typing
const ChatInputForm = React.memo(forwardRef<ChatInputFormHandle, ChatInputFormProps>(({
  onSubmit,
  onStop,
  isStreaming,
  model,
  onModelChange,
  availableModels,
  favoriteModels,
}, ref) => {
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    addImages: (images: PendingImage[]) => setPendingImages(prev => [...prev, ...images]),
  }));

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const rafId = requestAnimationFrame(() => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });

    return () => cancelAnimationFrame(rafId);
  }, [input]);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const arrayBuffer = await blob.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const preview = URL.createObjectURL(blob);

        setPendingImages(prev => [...prev, { data, mimeType: item.type, preview }]);
      }
    }
  };

  const handleRemoveImage = (index: number) => {
    setPendingImages(prev => {
      const removed = prev[index];
      if (removed) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && pendingImages.length === 0) || isStreaming) return;

    const message = input.trim();
    const images = [...pendingImages];

    setInput('');
    setPendingImages([]);

    await onSubmit(message, images);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="input-form">
      {pendingImages.length > 0 && (
        <div className="pending-images">
          {pendingImages.map((img, idx) => (
            <div key={idx} className="pending-image">
              <img src={img.preview} alt={`Pending ${idx + 1}`} />
              <button
                type="button"
                className="remove-image"
                onClick={() => handleRemoveImage(idx)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-row">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isMobile ? "Send a message..." : "Send a message... (drop or paste images)"}
          disabled={isStreaming}
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <ModelSelector
          value={model}
          onChange={onModelChange}
          disabled={isStreaming}
          models={availableModels}
          favoriteModels={favoriteModels}
        />
        {isStreaming ? (
          <button type="button" onClick={onStop} className="send-button stop-button">
            ■
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() && pendingImages.length === 0} className="send-button">
            ↑
          </button>
        )}
      </div>
    </form>
  );
}));

interface ChatInterfaceProps {
  conversation: Conversation | null;
  onSendMessage: (content: string, attachments: Attachment[], onChunk?: (text: string) => void, signal?: AbortSignal) => Promise<void>;
  onSaveImage: (conversationId: string, imageData: Uint8Array, mimeType: string) => Promise<Attachment>;
  loadImageAsBase64: (relativePath: string) => Promise<{ base64: string; mimeType: string }>;
  hasProvider: boolean;
  onModelChange: (modelKey: string) => void;  // Format: "provider/model-id"
  availableModels: ModelInfo[];
  favoriteModels?: string[];  // Format: "provider/model-id"
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  scrollToMessageId?: string | null;  // Message ID to scroll to (from provenance links)
  onScrollComplete?: () => void;  // Called after scrolling to message
  onBack?: () => void;  // Back button callback (mobile: shows menu icon, desktop: shows back arrow)
  canGoBack?: boolean;  // Whether there's navigation history to go back to
}

export interface ChatInterfaceHandle {
  focusInput: () => void;
  openFind: () => void;
}

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

const getAssistantName = (model: string): string => {
  const provider = getProviderFromModel(model);
  switch (provider) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'ChatGPT';
    case 'gemini':
      return 'Gemini';
    case 'ollama':
      return 'Assistant';
    default:
      return 'Assistant';
  }
};

export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(({
  conversation,
  onSendMessage,
  onSaveImage,
  loadImageAsBase64,
  hasProvider,
  onModelChange,
  availableModels,
  favoriteModels,
  onNavigateToNote,
  onNavigateToConversation,
  scrollToMessageId,
  onScrollComplete,
  onBack,
  canGoBack,
}, ref) => {
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const dragCounterRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputFormHandle>(null);
  const findRef = useRef<FindInConversationHandle>(null);
  const currentConversationIdRef = useRef<string | null>(conversation?.id ?? null);

  // Keep ref in sync with current conversation
  currentConversationIdRef.current = conversation?.id ?? null;

  const {
    isStreaming,
    streamingContent,
    streamingToolUse,
    start: startStreaming,
    stop: stopStreaming,
    updateContent,
    complete: completeStreaming,
    clear: clearStreaming,
  } = useConversationStreaming(conversation?.id ?? null);

  // Clear streaming content once the assistant message appears in the conversation
  const lastMessage = conversation?.messages[conversation.messages.length - 1];
  const hasCompletedContent = !isStreaming && !!streamingContent;

  useEffect(() => {
    if (hasCompletedContent && lastMessage?.role === 'assistant') {
      clearStreaming();
    }
  }, [hasCompletedContent, lastMessage?.role, clearStreaming]);

  // Show streaming message if actively streaming OR if we have completed content waiting to be replaced
  const showStreamingMessage = isStreaming || hasCompletedContent;

  const assistantName = conversation ? getAssistantName(conversation.model) : 'Assistant';

  // Use ref to keep getImageUrl callback stable - prevents message re-renders when imageUrls changes
  const imageUrlsRef = useRef(imageUrls);
  imageUrlsRef.current = imageUrls;
  const getImageUrl = useCallback((path: string) => imageUrlsRef.current[path], []);

  // Memoize the rendered messages to prevent expensive re-renders during typing
  const renderedMessages = useMemo(() => {
    if (!conversation) return null;

    return conversation.messages.map((message, index) => {
      // Skip rendering the last assistant message if we still have streaming content
      const isLastMessage = index === conversation.messages.length - 1;
      if (isLastMessage && message.role === 'assistant' && streamingContent) {
        return null;
      }

      if (message.role === 'log') {
        return <LogMessage key={`${conversation.id}-${index}`} message={message} />;
      }

      if (message.role === 'user') {
        return (
          <div key={`${conversation.id}-${index}`} data-message-id={message.id}>
            <UserMessage
              message={message}
              getImageUrl={getImageUrl}
              onNavigateToNote={onNavigateToNote}
              onNavigateToConversation={onNavigateToConversation}
            />
          </div>
        );
      }

      // Assistant messages use AgentResponseView
      return (
        <div key={`${conversation.id}-${index}`} data-message-id={message.id}>
          <AgentResponseView
            content={message.content}
            status="complete"
            toolUses={message.toolUse}
            skillUses={message.skillUse}
            onNavigateToNote={onNavigateToNote}
            onNavigateToConversation={onNavigateToConversation}
            headerContent={assistantName}
          />
        </div>
      );
    });
  }, [conversation, getImageUrl, streamingContent, assistantName]);

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      chatInputRef.current?.focus();
    },
    openFind: () => {
      if (showFind) {
        // Already open, just focus the input
        findRef.current?.focus();
      } else {
        setShowFind(true);
      }
    }
  }));

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const threshold = 50;
    const isNearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
    setShouldAutoScroll(isNearBottom);
  };

  useEffect(() => {
    if (shouldAutoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [conversation?.messages, streamingContent, shouldAutoScroll]);

  // Scroll to bottom when switching conversations (unless scrollToMessageId is set)
  useEffect(() => {
    // Skip if we have a pending scroll target - let the scroll-to-message effect handle it
    if (scrollToMessageId) return;

    if (conversation && conversation.messages.length > 0) {
      const container = messagesContainerRef.current;
      if (container) {
        // Reset scroll position first, then scroll to bottom after layout completes
        container.scrollTop = 0;
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }
    }
  }, [conversation?.id, scrollToMessageId]);

  // Close find dialog when conversation changes
  useEffect(() => {
    setShowFind(false);
  }, [conversation?.id]);

  // Scroll to specific message when scrollToMessageId is set (from provenance links)
  useScrollToMessage({
    containerRef: messagesContainerRef,
    messageId: scrollToMessageId,
    onScrollComplete,
  });

  useEffect(() => {
    if (conversation && conversation.messages.length === 0) {
      chatInputRef.current?.focus();
    }
  }, [conversation?.id]);

  const handleStop = useCallback(() => {
    stopStreaming();
  }, [stopStreaming]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const newImages: PendingImage[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const preview = URL.createObjectURL(file);
        newImages.push({ data, mimeType: file.type, preview });
      }
    }
    if (newImages.length > 0) {
      chatInputRef.current?.addImages(newImages);
    }
  };

  const handleFormSubmit = useCallback(async (message: string, pendingImages: PendingImage[]) => {
    if (!conversation) return;

    // Capture the conversation ID at submission time - user may navigate away during streaming
    const submittedConversationId = conversation.id;

    // Save images and collect attachments
    const attachments: Attachment[] = [];
    for (const img of pendingImages) {
      const attachment = await onSaveImage(conversation.id, img.data, img.mimeType);
      attachments.push(attachment);
      URL.revokeObjectURL(img.preview);
    }

    setShouldAutoScroll(true);

    // Start streaming and get AbortController
    const abortController = startStreaming();
    if (!abortController) return;

    // Helper to check if user is still viewing this conversation
    const checkIfStillViewing = () => {
      return currentConversationIdRef.current === submittedConversationId;
    };

    try {
      await onSendMessage(message, attachments, (chunk) => {
        updateContent(chunk);
      }, abortController.signal);
      completeStreaming(checkIfStillViewing());
    } catch (error) {
      completeStreaming(checkIfStillViewing());
      // Don't rethrow if it was an abort
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw error;
    }
  }, [conversation, onSaveImage, onSendMessage, startStreaming, updateContent, completeStreaming]);

  // Global Escape key handler for stopping streaming
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault();
        handleStop();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isStreaming]);

  // Load image URLs for displaying in messages
  useEffect(() => {
    const loadImages = async () => {
      if (!conversation) return;

      const attachments = conversation.messages
        .flatMap(m => m.attachments || [])
        .filter(a => a.type === 'image');

      const newUrls: Record<string, string> = {};
      for (const attachment of attachments) {
        if (!imageUrls[attachment.path]) {
          try {
            const { base64, mimeType } = await loadImageAsBase64(attachment.path);
            newUrls[attachment.path] = `data:${mimeType};base64,${base64}`;
          } catch (e) {
            console.error('Failed to load image:', attachment.path, e);
          }
        }
      }

      if (Object.keys(newUrls).length > 0) {
        setImageUrls(prev => ({ ...prev, ...newUrls }));
      }
    };

    loadImages();
  }, [conversation?.messages, loadImageAsBase64]);

  if (!hasProvider) {
    return (
      <div className="chat-interface">
        <div className="no-provider">
          <h2>No Provider Configured</h2>
          <p>Open Settings to configure an AI provider.</p>
        </div>
      </div>
    );
  }

  if (!conversation) {
    // On mobile with onBack, show full interface with input form for new conversations
    if (onBack) {
      return (
        <div
          className={`chat-interface ${isDragging ? 'drag-over' : ''} has-header`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <ItemHeader
            title="New Conversation"
            onBack={onBack}
            canGoBack={true}
          />
          <div className="messages-container" ref={messagesContainerRef}>
            <div className="welcome-message">
              <h2>Start a conversation</h2>
              <p>Ask me anything. Your conversation will be saved as a YAML file in your vault.</p>
            </div>
          </div>
          <ChatInputForm
            ref={chatInputRef}
            onSubmit={handleFormSubmit}
            onStop={handleStop}
            isStreaming={isStreaming}
            model={availableModels[0]?.key || ''}
            onModelChange={onModelChange}
            availableModels={availableModels}
            favoriteModels={favoriteModels}
          />
        </div>
      );
    }
    // On desktop, show simple message
    return (
      <div className="chat-interface">
        <div className="no-conversation">
          <h2>No conversation selected</h2>
          <p>Click the + button to start a new conversation</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`chat-interface ${isDragging ? 'drag-over' : ''} has-header`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ItemHeader
        title={conversation?.title || 'New Conversation'}
        onBack={onBack}
        canGoBack={canGoBack}
      />
      <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
        {showFind && (
          <FindInConversation
            ref={findRef}
            containerRef={messagesContainerRef}
            onClose={() => setShowFind(false)}
          />
        )}
        {conversation.messages.length === 0 && !showStreamingMessage && (
          <div className="welcome-message">
            <h2>Start a conversation</h2>
            <p>Ask me anything. Your conversation will be saved as a YAML file in your vault.</p>
          </div>
        )}

        {conversation.messages.length > 0 && (
          <div className="model-info">
            <span className="model-provider">{PROVIDER_NAMES[getProviderFromModel(conversation.model)]}</span>
            <span className="model-separator">·</span>
            <span className="model-name">{getModelIdFromModel(conversation.model)}</span>
          </div>
        )}

        {renderedMessages}

        {showStreamingMessage && (
          <AgentResponseView
            content={streamingContent || ''}
            status={isStreaming ? 'streaming' : 'pending'}
            toolUses={streamingToolUse}
            headerContent={assistantName}
            onNavigateToNote={onNavigateToNote}
            onNavigateToConversation={onNavigateToConversation}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      <ChatInputForm
        ref={chatInputRef}
        onSubmit={handleFormSubmit}
        onStop={handleStop}
        isStreaming={isStreaming}
        model={conversation?.model || ''}
        onModelChange={onModelChange}
        availableModels={availableModels}
        favoriteModels={favoriteModels}
      />
    </div>
  );
});
