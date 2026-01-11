import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Conversation } from '../types';
import { ModelSelector } from './ModelSelector';
import './ChatInterface.css';
import 'highlight.js/styles/github-dark.css';

interface ChatInterfaceProps {
  conversation: Conversation | null;
  onSendMessage: (content: string, onChunk?: (text: string) => void) => Promise<void>;
  hasApiKey: boolean;
  onApiKeyUpdate: (apiKey: string) => void;
  onModelChange: (model: string) => void;
}

export interface ChatInterfaceHandle {
  focusInput: () => void;
}

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4' },
  { id: 'claude-3-7-sonnet-20250219', name: 'Sonnet 3.7' },
];

export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(({
  conversation,
  onSendMessage,
  hasApiKey,
  onApiKeyUpdate,
  onModelChange,
}, ref) => {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      textareaRef.current?.focus();
    }
  }));

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation?.messages, streamingContent]);

  // Auto-focus the input when a new conversation is created
  useEffect(() => {
    if (conversation && conversation.messages.length === 0 && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [conversation?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !conversation) return;

    const message = input.trim();
    setInput('');
    setIsStreaming(true);
    setStreamingContent('');

    try {
      await onSendMessage(message, (chunk) => {
        setStreamingContent((prev) => prev + chunk);
      });
      // Success - streaming content will be cleared
      setIsStreaming(false);
      setStreamingContent('');
    } catch (error) {
      // Error occurred - reset state and let parent handle the error
      setIsStreaming(false);
      setStreamingContent('');
      throw error; // Re-throw to let parent show error message
    }
  };

  const handleApiKeySubmit = () => {
    if (apiKeyInput.trim()) {
      onApiKeyUpdate(apiKeyInput.trim());
      setApiKeyInput('');
      setShowApiKeyInput(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [input]);

  if (!hasApiKey) {
    return (
      <div className="chat-interface">
        <div className="api-key-setup">
          <h2>API Key Required</h2>
          <p>Enter your Anthropic API key to start chatting with Claude.</p>
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-ant-..."
            className="api-key-input"
            onKeyDown={(e) => e.key === 'Enter' && handleApiKeySubmit()}
          />
          <button onClick={handleApiKeySubmit} className="api-key-submit">
            Save API Key
          </button>
          <p className="api-key-note">
            Your API key is stored locally in your vault's config.yaml file.
          </p>
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
      <div className="messages-container">
        {conversation.messages.length === 0 && !isStreaming && (
          <div className="welcome-message">
            <h2>Start a conversation</h2>
            <p>Ask me anything. Your conversation will be saved as a YAML file in your vault.</p>
          </div>
        )}

        {conversation.messages.length > 0 && (
          <div className="model-info">
            <span className="model-provider">Anthropic</span>
            <span className="model-separator">·</span>
            <span className="model-name">{conversation.model}</span>
          </div>
        )}

        {conversation.messages.map((message, index) => (
          <div key={index} className={`message ${message.role}`}>
            <div className="message-role">
              {message.role === 'user' ? 'You' : 'Claude'}
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
        ))}

        {isStreaming && streamingContent && (
          <div className="message assistant streaming">
            <div className="message-role">Claude</div>
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
          value={conversation?.model || 'claude-opus-4-5-20251101'}
          onChange={onModelChange}
          disabled={isStreaming || (conversation?.messages.length ?? 0) > 0}
          models={AVAILABLE_MODELS}
        />
        <button type="submit" disabled={isStreaming || !input.trim()} className="send-button">
          ↑
        </button>
      </form>

      {showApiKeyInput && (
        <div className="api-key-modal">
          <div className="api-key-modal-content">
            <h3>Update API Key</h3>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="sk-ant-..."
              className="api-key-input"
            />
            <div className="api-key-modal-actions">
              <button onClick={handleApiKeySubmit}>Save</button>
              <button onClick={() => setShowApiKeyInput(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
