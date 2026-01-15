import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Conversation, ModelInfo, ProviderType } from '../types';
import { ModelSelector } from './ModelSelector';
import './ChatInterface.css';
import 'highlight.js/styles/github-dark.css';

interface ChatInterfaceProps {
  conversation: Conversation | null;
  onSendMessage: (content: string, onChunk?: (text: string) => void, signal?: AbortSignal) => Promise<void>;
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
  hasProvider,
  onModelChange,
  availableModels,
}, ref) => {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    if (conversation && conversation.messages.length === 0 && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [conversation?.id]);

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !conversation) return;

    const message = input.trim();
    setInput('');
    setIsStreaming(true);
    setStreamingContent('');
    setShouldAutoScroll(true);

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();

    try {
      await onSendMessage(message, (chunk) => {
        setStreamingContent((prev) => prev + chunk);
      }, abortControllerRef.current.signal);
      setIsStreaming(false);
      setStreamingContent('');
    } catch (error) {
      setIsStreaming(false);
      setStreamingContent('');
      // Don't rethrow if it was an abort
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw error;
    } finally {
      abortControllerRef.current = null;
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
    <div className="chat-interface">
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
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
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
          <button type="submit" disabled={!input.trim()} className="send-button">
            ↑
          </button>
        )}
      </form>
    </div>
  );
});
