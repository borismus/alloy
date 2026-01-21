import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Conversation, ModelInfo, ProviderType, Message } from '../types';
import { useCouncilStreaming, CouncilPhase } from '../hooks/useCouncilStreaming';
import { skillRegistry } from '../services/skills';
import './ChatInterface.css';  // Base styles shared with comparison mode
import './CouncilChatInterface.css';  // Council-specific overrides
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
  gemini: 'Gemini',
};

interface CouncilChatInterfaceProps {
  conversation: Conversation;
  availableModels: ModelInfo[];
  onUpdateConversation: (conversation: Conversation) => void;
}

export interface CouncilChatInterfaceHandle {
  focusInput: () => void;
}

const getModelKey = (model: ModelInfo) => `${model.provider}:${model.id}`;

export const CouncilChatInterface = forwardRef<CouncilChatInterfaceHandle, CouncilChatInterfaceProps>(({
  conversation,
  availableModels,
  onUpdateConversation,
}, ref) => {
  const [input, setInput] = useState('');
  const [hasSubmittedFirst, setHasSubmittedFirst] = useState(conversation.messages.length > 0);
  const [showModelsDropdown, setShowModelsDropdown] = useState(false);
  const [currentUserMessage, setCurrentUserMessage] = useState<string | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [collapsedExchanges, setCollapsedExchanges] = useState<Set<number>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get the ModelInfo objects for the council members and chairman
  const councilMembers = conversation.council?.councilMembers.map(m =>
    availableModels.find(am => am.id === m.model && am.provider === m.provider)
  ).filter((m): m is ModelInfo => m !== undefined) || [];

  const chairman = conversation.council?.chairman
    ? availableModels.find(am =>
        am.id === conversation.council!.chairman.model &&
        am.provider === conversation.council!.chairman.provider
      )
    : undefined;

  const systemPrompt = skillRegistry.buildSystemPrompt({
    id: conversation.id,
    title: conversation.title,
  });

  const {
    memberContents,
    memberStatuses,
    memberErrors,
    chairmanContent,
    chairmanStatus,
    chairmanError,
    currentPhase,
    startCouncilStreaming,
    stopAll,
    isAnyStreaming,
  } = useCouncilStreaming({
    conversationId: conversation.id,
    isCurrentConversation: true,
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
    const threshold = 50;
    const isNearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
    setShouldAutoScroll(isNearBottom);
  }, []);

  // Auto-scroll to bottom when messages change or during streaming
  useEffect(() => {
    if (shouldAutoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [conversation.messages, memberContents, chairmanContent, isAnyStreaming, shouldAutoScroll]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isAnyStreaming || !chairman) return;

    const userMessage = input.trim();
    setInput('');
    setHasSubmittedFirst(true);
    setCurrentUserMessage(userMessage);
    setShouldAutoScroll(true);

    // Add user message to conversation
    const userMessageObj: Message = {
      role: 'user',
      timestamp: new Date().toISOString(),
      content: userMessage,
    };

    const updatedConversation = {
      ...conversation,
      messages: [...conversation.messages, userMessageObj],
    };
    onUpdateConversation(updatedConversation);

    // Start council streaming
    const result = await startCouncilStreaming(userMessage, councilMembers, chairman);

    // Add council member responses
    const memberMessages: Message[] = result.memberResponses.map((response, index) => ({
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: memberContents.get(getModelKey(councilMembers[index])) || response.content || '',
      provider: response.provider,
      model: response.model,
      councilMember: true,
    }));

    // Add chairman response
    const chairmanMessage: Message = {
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: chairmanContent || result.chairmanResponse.content || '',
      provider: result.chairmanResponse.provider,
      model: result.chairmanResponse.model,
      chairman: true,
    };

    const finalConversation = {
      ...updatedConversation,
      messages: [...updatedConversation.messages, ...memberMessages, chairmanMessage],
    };
    onUpdateConversation(finalConversation);

    // Auto-collapse the council responses for this exchange
    const exchangeIndex = groupMessagesByCouncilExchange(
      finalConversation.messages,
      councilMembers.length
    ).length - 1;
    setCollapsedExchanges(prev => new Set(prev).add(exchangeIndex));
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

  const toggleExchangeCollapse = (index: number) => {
    setCollapsedExchanges(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const getPhaseLabel = (phase: CouncilPhase): string => {
    switch (phase) {
      case 'idle': return 'Ready';
      case 'individual': return 'Council deliberating...';
      case 'synthesis': return 'Chairman synthesizing...';
      case 'complete': return 'Complete';
    }
  };

  // Show model names in header
  const chairmanName = chairman?.name || 'Chairman';

  return (
    <div className="chat-interface council-mode">
      <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
        {!hasSubmittedFirst && (
          <div className="welcome-message council-welcome">
            <h2>Council Mode</h2>
            <p>
              <strong>{councilMembers.length}</strong> council members will respond, then{' '}
              <strong>{chairmanName}</strong> will synthesize their answers.
            </p>
          </div>
        )}

        {/* Show all exchanges including current streaming */}
        {(conversation.messages.length > 0 || isAnyStreaming) && (
          <div className="council-history">
            {/* Previous completed exchanges */}
            {groupMessagesByCouncilExchange(conversation.messages, councilMembers.length, isAnyStreaming).map((group, groupIndex) => (
              <div key={groupIndex} className="council-exchange">
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

                {/* Council member responses (collapsible) */}
                <div className={`council-responses-section ${collapsedExchanges.has(groupIndex) ? 'collapsed' : ''}`}>
                  <button
                    className="council-responses-toggle"
                    onClick={() => toggleExchangeCollapse(groupIndex)}
                  >
                    <span className="toggle-icon">{collapsedExchanges.has(groupIndex) ? '▶' : '▼'}</span>
                    <span className="toggle-label">
                      {councilMembers.length} council responses
                    </span>
                  </button>
                  {!collapsedExchanges.has(groupIndex) && (
                    <div className="council-responses-grid">
                      {group.memberResponses.map((response, respIndex) => (
                        <div key={respIndex} className="response-summary council-member-response">
                          <div className="response-summary-header">
                            {getModelDisplayName(response, respIndex, councilMembers, conversation.council?.councilMembers)}
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
                  )}
                </div>

                {/* Chairman synthesis */}
                {group.chairmanResponse && (
                  <div className="chairman-response">
                    <div className="chairman-header">
                      <span className="chairman-icon">👑</span>
                      <span className="chairman-label">
                        {getChairmanDisplayName(group.chairmanResponse, chairman, conversation.council?.chairman)}
                      </span>
                    </div>
                    <div className="chairman-content">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                        components={markdownComponents}
                      >
                        {group.chairmanResponse.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Current streaming exchange */}
            {isAnyStreaming && currentUserMessage && (
              <div className="council-exchange streaming">
                {/* Phase indicator */}
                <div className="council-phase-indicator">
                  <div className={`phase-step ${currentPhase === 'individual' ? 'active' : currentPhase === 'synthesis' || currentPhase === 'complete' ? 'complete' : ''}`}>
                    <span className="phase-dot" />
                    <span className="phase-label">Council</span>
                  </div>
                  <div className="phase-connector" />
                  <div className={`phase-step ${currentPhase === 'synthesis' ? 'active' : currentPhase === 'complete' ? 'complete' : ''}`}>
                    <span className="phase-dot" />
                    <span className="phase-label">Chairman</span>
                  </div>
                  <span className="phase-status">{getPhaseLabel(currentPhase)}</span>
                </div>

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

                {/* Streaming council responses */}
                <div className="council-responses-section">
                  <div className="council-responses-toggle">
                    <span className="toggle-icon">▼</span>
                    <span className="toggle-label">
                      {councilMembers.length} council responses
                    </span>
                  </div>
                  <div className="council-responses-grid">
                    {councilMembers.map((model) => {
                      const modelKey = getModelKey(model);
                      const content = memberContents.get(modelKey) || '';
                      const status = memberStatuses.get(modelKey) || 'pending';
                      const error = memberErrors.get(modelKey);

                      return (
                        <div key={modelKey} className={`response-summary council-member-response status-${status}`}>
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

                {/* Streaming chairman response */}
                {(currentPhase === 'synthesis' || currentPhase === 'complete') && (
                  <div className={`chairman-response status-${chairmanStatus}`}>
                    <div className="chairman-header">
                      <span className="chairman-icon">👑</span>
                      <span className="chairman-label">{chairmanName}</span>
                      {chairmanStatus === 'streaming' && <span className="streaming-indicator" />}
                    </div>
                    <div className="chairman-content">
                      {chairmanStatus === 'pending' && (
                        <span className="waiting-text">Preparing synthesis...</span>
                      )}
                      {chairmanStatus === 'streaming' && !chairmanContent && (
                        <div className="thinking-indicator">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      )}
                      {chairmanContent && (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight]}
                          components={markdownComponents}
                        >
                          {chairmanContent}
                        </ReactMarkdown>
                      )}
                      {chairmanStatus === 'error' && (
                        <span className="error-text">{chairmanError || 'An error occurred'}</span>
                      )}
                    </div>
                  </div>
                )}
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
            placeholder="Ask the council..."
            disabled={isAnyStreaming}
            rows={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="council-model-indicator-wrapper" ref={dropdownRef}>
            <button
              type="button"
              className="council-model-indicator"
              onClick={() => setShowModelsDropdown(!showModelsDropdown)}
            >
              {councilMembers.length}+1
              <svg className={`dropdown-arrow ${showModelsDropdown ? 'open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none">
                <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {showModelsDropdown && (
              <div className="council-models-dropdown">
                <div className="dropdown-section-header">Council Members</div>
                {councilMembers.map((model) => (
                  <div key={`${model.provider}:${model.id}`} className="council-model-item">
                    <span className="council-model-name">{model.name}</span>
                    <span className={`council-model-provider provider-${model.provider}`}>
                      {PROVIDER_NAMES[model.provider]}
                    </span>
                  </div>
                ))}
                <div className="dropdown-section-header chairman">
                  <span className="chairman-icon">👑</span> Chairman
                </div>
                {chairman && (
                  <div className="council-model-item chairman-item">
                    <span className="council-model-name">{chairman.name}</span>
                    <span className={`council-model-provider provider-${chairman.provider}`}>
                      {PROVIDER_NAMES[chairman.provider]}
                    </span>
                  </div>
                )}
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
  provider?: ProviderType;
  model?: string;
}

interface CouncilExchangeGroup {
  userMessage: string;
  memberResponses: ResponseWithModel[];
  chairmanResponse?: ResponseWithModel;
}

// Helper function to group messages by council exchange
function groupMessagesByCouncilExchange(
  messages: Message[],
  memberCount: number,
  excludeIncomplete: boolean = false
): CouncilExchangeGroup[] {
  const groups: CouncilExchangeGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const userMessage = msg.content;
      const memberResponses: ResponseWithModel[] = [];
      let chairmanResponse: ResponseWithModel | undefined;

      // Collect council member responses
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'assistant' && messages[j].councilMember) {
        memberResponses.push({
          content: messages[j].content,
          provider: messages[j].provider,
          model: messages[j].model,
        });
        j++;
      }

      // Collect chairman response
      if (j < messages.length && messages[j].role === 'assistant' && messages[j].chairman) {
        chairmanResponse = {
          content: messages[j].content,
          provider: messages[j].provider,
          model: messages[j].model,
        };
        j++;
      }

      // Skip incomplete exchanges when streaming
      if (excludeIncomplete && (memberResponses.length < memberCount || !chairmanResponse)) {
        i = j;
        continue;
      }

      groups.push({ userMessage, memberResponses, chairmanResponse });
      i = j;
    } else {
      i++;
    }
  }

  return groups;
}

// Get display name for a council member
function getModelDisplayName(
  response: ResponseWithModel,
  index: number,
  councilMembers: ModelInfo[],
  conversationModels?: Array<{ provider: ProviderType; model: string }>
): string {
  if (response.provider && response.model) {
    const matchedModel = councilMembers.find(
      m => m.provider === response.provider && m.id === response.model
    );
    if (matchedModel) return matchedModel.name;
    return response.model;
  }

  if (conversationModels && conversationModels[index]) {
    const meta = conversationModels[index];
    const matchedModel = councilMembers.find(
      m => m.provider === meta.provider && m.id === meta.model
    );
    if (matchedModel) return matchedModel.name;
    return meta.model;
  }

  if (councilMembers[index]) {
    return councilMembers[index].name;
  }

  return `Member ${index + 1}`;
}

// Get display name for the chairman
function getChairmanDisplayName(
  response: ResponseWithModel,
  chairman: ModelInfo | undefined,
  conversationChairman?: { provider: ProviderType; model: string }
): string {
  if (chairman) {
    return chairman.name;
  }

  if (response.provider && response.model) {
    return response.model;
  }

  if (conversationChairman) {
    return conversationChairman.model;
  }

  return 'Chairman';
}
