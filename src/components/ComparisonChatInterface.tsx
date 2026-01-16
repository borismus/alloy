import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Conversation, ModelInfo, ComparisonResponse, ProviderType } from '../types';
import { useComparisonStreaming } from '../hooks/useComparisonStreaming';
import { skillRegistry } from '../services/skills';
import './ChatInterface.css';
import 'highlight.js/styles/github-dark.css';

// Custom link renderer that opens URLs in system browser
const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          openUrl(href);
        }
      }}
    >
      {children}
    </a>
  ),
};

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Google Gemini',
};

interface ComparisonChatInterfaceProps {
  conversation: Conversation;
  availableModels: ModelInfo[];
  onUpdateConversation: (conversation: Conversation) => void;
}

export interface ComparisonChatInterfaceHandle {
  focusInput: () => void;
}

const getModelKey = (model: ModelInfo) => `${model.provider}:${model.id}`;

export const ComparisonChatInterface = forwardRef<ComparisonChatInterfaceHandle, ComparisonChatInterfaceProps>(({
  conversation,
  availableModels,
  onUpdateConversation,
}, ref) => {
  const [input, setInput] = useState('');
  const [hasSubmittedFirst, setHasSubmittedFirst] = useState(conversation.messages.length > 0);
  const [showModelsDropdown, setShowModelsDropdown] = useState(false);
  const [currentUserMessage, setCurrentUserMessage] = useState<string | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get the ModelInfo objects for the comparison models
  const comparisonModels = conversation.comparison?.models.map(m =>
    availableModels.find(am => am.id === m.model && am.provider === m.provider)
  ).filter((m): m is ModelInfo => m !== undefined) || [];

  const systemPrompt = skillRegistry.buildSystemPrompt();

  const {
    streamingContents,
    statuses,
    errors,
    startStreaming,
    stopAll,
    isAnyStreaming,
  } = useComparisonStreaming({
    conversationId: conversation.id,
    isCurrentConversation: true, // Component is only mounted when it's the current conversation
    systemPrompt,
    existingMessages: conversation.messages,
  });

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      textareaRef.current?.focus();
    }
  }));

  useEffect(() => {
    if (conversation.messages.length === 0 && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [conversation?.id]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [input]);

  // Global Escape key handler for stopping streaming
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isAnyStreaming) {
        e.preventDefault();
        stopAll();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isAnyStreaming, stopAll]);

  // Click outside handler for models dropdown
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
      setShowModelsDropdown(false);
    }
  }, []);

  useEffect(() => {
    if (showModelsDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showModelsDropdown, handleClickOutside]);

  // Clear current user message when streaming ends
  useEffect(() => {
    if (!isAnyStreaming) {
      setCurrentUserMessage(null);
    }
  }, [isAnyStreaming]);

  // Handle scroll to detect if user scrolled away from bottom
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const threshold = 100;
    const isNearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
    setShouldAutoScroll(isNearBottom);
  }, []);

  // Auto-scroll to bottom when messages change or during streaming (only if user hasn't scrolled up)
  useEffect(() => {
    if (shouldAutoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [conversation.messages, streamingContents, isAnyStreaming, shouldAutoScroll]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isAnyStreaming) return;

    const userMessage = input.trim();
    setInput('');
    setHasSubmittedFirst(true);
    setCurrentUserMessage(userMessage);
    setShouldAutoScroll(true);

    // Add user message to conversation
    const userMessageObj = {
      role: 'user' as const,
      timestamp: new Date().toISOString(),
      content: userMessage,
    };

    const updatedConversation = {
      ...conversation,
      messages: [...conversation.messages, userMessageObj],
    };
    onUpdateConversation(updatedConversation);

    // Start streaming to all models
    const responses = await startStreaming(userMessage, comparisonModels);

    // Add responses to conversation (using final content from streaming)
    const assistantMessages = responses.map((response: ComparisonResponse, index: number) => ({
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: streamingContents.get(getModelKey(comparisonModels[index])) || response.content || '',
      provider: response.provider,
      model: response.model,
    }));

    const finalConversation = {
      ...updatedConversation,
      messages: [...updatedConversation.messages, ...assistantMessages],
    };
    onUpdateConversation(finalConversation);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
    if (e.key === 'Escape' && isAnyStreaming) {
      e.preventDefault();
      stopAll();
    }
  };

  // Show model names in header
  const modelNames = comparisonModels.map(m => m.name).join(' vs ');

  return (
    <div className="chat-interface comparison-mode">
      <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
        {!hasSubmittedFirst && (
          <div className="welcome-message">
            <h2>Compare: {modelNames}</h2>
            <p>Send a message to compare responses from {comparisonModels.length} models side by side.</p>
          </div>
        )}

        {/* Show all exchanges including current streaming */}
        {(conversation.messages.length > 0 || isAnyStreaming) && (
          <div className="comparison-history">
            {/* Previous completed exchanges - exclude current streaming exchange */}
            {groupMessagesByPrompt(conversation.messages, comparisonModels.length, isAnyStreaming).map((group, groupIndex) => (
              <div key={groupIndex} className="comparison-exchange">
                <div className="message user">
                  <div className="message-role">You</div>
                  <div className="message-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={markdownComponents}
                    >
                      {group.userMessage}
                    </ReactMarkdown>
                  </div>
                </div>
                <div className="comparison-responses-summary">
                  {group.responses.map((response, respIndex) => (
                    <div key={respIndex} className="response-summary">
                      <div className="response-summary-header">
                        {getModelDisplayName(response, respIndex, comparisonModels, conversation.comparison?.models)}
                      </div>
                      <div className="response-summary-content">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight]}
                          components={markdownComponents}
                        >
                          {response.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Current streaming exchange */}
            {isAnyStreaming && currentUserMessage && (
              <div className="comparison-exchange streaming">
                <div className="message user">
                  <div className="message-role">You</div>
                  <div className="message-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={markdownComponents}
                    >
                      {currentUserMessage}
                    </ReactMarkdown>
                  </div>
                </div>
                <div className="comparison-responses-summary">
                  {comparisonModels.map((model) => {
                    const modelKey = getModelKey(model);
                    const content = streamingContents.get(modelKey) || '';
                    const status = statuses.get(modelKey) || 'pending';
                    const error = errors.get(modelKey);

                    return (
                      <div key={modelKey} className={`response-summary status-${status}`}>
                        <div className="response-summary-header">
                          {model.name}
                          {status === 'streaming' && <span className="streaming-indicator" />}
                        </div>
                        <div className="response-summary-content">
                          {status === 'pending' && (
                            <span className="waiting-text">Waiting...</span>
                          )}
                          {status === 'streaming' && !content && (
                            <div className="thinking-indicator">
                              <span></span>
                              <span></span>
                              <span></span>
                            </div>
                          )}
                          {content && (
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeHighlight]}
                              components={markdownComponents}
                            >
                              {content}
                            </ReactMarkdown>
                          )}
                          {status === 'error' && (
                            <span className="error-text">{error || 'An error occurred'}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="input-form">
        <div className="input-row">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message to compare..."
            disabled={isAnyStreaming}
            rows={1}
          />
          <div className="comparison-model-indicator-wrapper" ref={dropdownRef}>
            <button
              type="button"
              className="comparison-model-indicator"
              onClick={() => setShowModelsDropdown(!showModelsDropdown)}
            >
              {comparisonModels.length} models
              <svg className={`dropdown-arrow ${showModelsDropdown ? 'open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none">
                <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {showModelsDropdown && (
              <div className="comparison-models-dropdown">
                {comparisonModels.map((model) => (
                  <div key={`${model.provider}:${model.id}`} className="comparison-model-item">
                    <span className="comparison-model-name">{model.name}</span>
                    <span className={`comparison-model-provider provider-${model.provider}`}>
                      {PROVIDER_NAMES[model.provider]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {isAnyStreaming ? (
            <button type="button" onClick={stopAll} className="send-button stop-button">
              ■
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="send-button">
              ↑
            </button>
          )}
        </div>
      </form>
    </div>
  );
});

interface ResponseWithModel {
  content: string;
  provider?: string;
  model?: string;
}

interface MessageGroup {
  userMessage: string;
  responses: ResponseWithModel[];
}

// Helper function to group messages by user prompt for display
function groupMessagesByPrompt(messages: Conversation['messages'], modelCount: number, excludeIncomplete: boolean = false): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const userMessage = msg.content;
      const responses: ResponseWithModel[] = [];

      // Collect following assistant messages
      for (let j = 0; j < modelCount && i + 1 + j < messages.length; j++) {
        const nextMsg = messages[i + 1 + j];
        if (nextMsg.role === 'assistant') {
          responses.push({
            content: nextMsg.content,
            provider: nextMsg.provider,
            model: nextMsg.model,
          });
        }
      }

      // Skip incomplete exchanges (user message without full responses) when streaming
      if (excludeIncomplete && responses.length < modelCount) {
        i += 1 + responses.length;
        continue;
      }

      groups.push({ userMessage, responses });
      i += 1 + responses.length;
    } else {
      i++;
    }
  }

  return groups;
}

// Get display name for a model, with fallback
function getModelDisplayName(
  response: ResponseWithModel,
  index: number,
  comparisonModels: ModelInfo[],
  conversationModels?: Array<{ provider: string; model: string }>
): string {
  // First try: look up by provider/model from the message itself
  if (response.provider && response.model) {
    const matchedModel = comparisonModels.find(
      m => m.provider === response.provider && m.id === response.model
    );
    if (matchedModel) return matchedModel.name;
    // Model not in availableModels, use raw model ID
    return response.model;
  }

  // Fallback for old conversations: use positional matching with conversation metadata
  if (conversationModels && conversationModels[index]) {
    const meta = conversationModels[index];
    const matchedModel = comparisonModels.find(
      m => m.provider === meta.provider && m.id === meta.model
    );
    if (matchedModel) return matchedModel.name;
    return meta.model;
  }

  // Last resort: use comparisonModels by index
  if (comparisonModels[index]) {
    return comparisonModels[index].name;
  }

  return `Model ${index + 1}`;
}
