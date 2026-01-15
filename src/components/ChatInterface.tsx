import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Conversation, ModelInfo, ProviderType, Attachment } from '../types';
import { useConversationStreaming } from '../hooks/useConversationStreaming';
import { ModelSelector } from './ModelSelector';
import './ChatInterface.css';
import 'highlight.js/styles/github-dark.css';

export interface PendingImage {
  data: Uint8Array;
  mimeType: string;
  preview: string; // Data URL for preview
}

interface ChatInterfaceProps {
  conversation: Conversation | null;
  onSendMessage: (content: string, attachments: Attachment[], onChunk?: (text: string) => void, signal?: AbortSignal) => Promise<void>;
  onSaveImage: (conversationId: string, imageData: Uint8Array, mimeType: string) => Promise<Attachment>;
  loadImageAsBase64: (relativePath: string) => Promise<{ base64: string; mimeType: string }>;
  hasProvider: boolean;
  onModelChange: (model: string, provider: ProviderType) => void;
  availableModels: ModelInfo[];
}

export interface ChatInterfaceHandle {
  focusInput: () => void;
}

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Google Gemini',
};

const getAssistantName = (provider: ProviderType): string => {
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
}, ref) => {
  const [input, setInput] = useState('');
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentConversationIdRef = useRef<string | null>(conversation?.id ?? null);

  // Keep ref in sync with current conversation
  currentConversationIdRef.current = conversation?.id ?? null;

  const {
    isStreaming,
    streamingContent,
    start: startStreaming,
    stop: stopStreaming,
    updateContent,
    complete: completeStreaming,
  } = useConversationStreaming(conversation?.id ?? null);

  const assistantName = conversation ? getAssistantName(conversation.provider) : 'Assistant';

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      textareaRef.current?.focus();
    }
  }));

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const threshold = 100;
    const isNearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
    setShouldAutoScroll(isNearBottom);
  };

  useEffect(() => {
    if (shouldAutoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [conversation?.messages, streamingContent, shouldAutoScroll]);

  // Scroll to bottom immediately when switching conversations
  useEffect(() => {
    if (conversation && conversation.messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [conversation?.id]);

  useEffect(() => {
    if (conversation && conversation.messages.length === 0 && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [conversation?.id]);

  const handleStop = () => {
    stopStreaming();
  };

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

        setPendingImages(prev => [...prev, {
          data,
          mimeType: item.type,
          preview
        }]);
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

    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const preview = URL.createObjectURL(file);

        setPendingImages(prev => [...prev, {
          data,
          mimeType: file.type,
          preview
        }]);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && pendingImages.length === 0) || isStreaming || !conversation) return;

    const message = input.trim();
    // Capture the conversation ID at submission time - user may navigate away during streaming
    const submittedConversationId = conversation.id;

    // Save images and collect attachments
    const attachments: Attachment[] = [];
    for (const img of pendingImages) {
      const attachment = await onSaveImage(conversation.id, img.data, img.mimeType);
      attachments.push(attachment);
      URL.revokeObjectURL(img.preview);
    }

    setInput('');
    setPendingImages([]);
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
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleStop();
    }
  };

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

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [input]);

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
      className={`chat-interface ${isDragging ? 'drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="messages-container" onScroll={handleScroll}>
        {conversation.messages.length === 0 && !isStreaming && (
          <div className="welcome-message">
            <h2>Start a conversation</h2>
            <p>Ask me anything. Your conversation will be saved as a YAML file in your vault.</p>
          </div>
        )}

        {conversation.messages.length > 0 && (
          <div className="model-info">
            <span className="model-provider">{PROVIDER_NAMES[conversation.provider]}</span>
            <span className="model-separator">·</span>
            <span className="model-name">{conversation.model}</span>
          </div>
        )}

        {conversation.messages.map((message, index) => (
          message.role === 'log' ? (
            <div key={index} className="message log">
              <div className="log-content">{message.content}</div>
            </div>
          ) : (
            <div key={index} className={`message ${message.role}`}>
              <div className="message-role">
                {message.role === 'user' ? 'You' : assistantName}
              </div>
              <div className="message-content">
                {message.attachments?.filter(a => a.type === 'image').map((attachment, imgIndex) => (
                  <div key={imgIndex} className="message-image">
                    {imageUrls[attachment.path] && (
                      <img src={imageUrls[attachment.path]} alt={`Attachment ${imgIndex + 1}`} />
                    )}
                  </div>
                ))}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
            </div>
          )
        ))}

        {isStreaming && !streamingContent && (
          <div className="message assistant thinking">
            <div className="message-role">{assistantName}</div>
            <div className="message-content">
              <div className="thinking-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        {isStreaming && streamingContent && (
          <div className="message assistant streaming">
            <div className="message-role">{assistantName}</div>
            <div className="message-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
              >
                {streamingContent}
              </ReactMarkdown>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

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
            placeholder="Send a message... (drop or paste images)"
            disabled={isStreaming}
            rows={1}
          />
          <ModelSelector
            value={conversation?.model || ''}
            onChange={onModelChange}
            disabled={isStreaming}
            models={availableModels}
          />
          {isStreaming ? (
            <button type="button" onClick={handleStop} className="send-button stop-button">
              ■
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() && pendingImages.length === 0} className="send-button">
              ↑
            </button>
          )}
        </div>
      </form>
    </div>
  );
});
