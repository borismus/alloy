import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Conversation, ModelInfo, ProviderType, Message, getProviderFromModel, getModelIdFromModel } from '../types';
import { useCouncilStreaming, CouncilPhase } from '../hooks/useCouncilStreaming';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useGlobalEscape } from '../hooks/useGlobalEscape';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useClickOutside } from '../hooks/useClickOutside';
import { TEXTAREA_PROPS } from '../utils/textareaProps';
import { skillRegistry } from '../services/skills';
import { AgentResponseView } from './AgentResponseView';
import { MarkdownContent } from './MarkdownContent';
import './ChatInterface.css';  // Base styles shared with comparison mode
import './CouncilChatInterface.css';  // Council-specific overrides

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
  memoryContent?: string;
}

export interface CouncilChatInterfaceHandle {
  focusInput: () => void;
}

// Use model.key directly - no need for helper function

export const CouncilChatInterface = forwardRef<CouncilChatInterfaceHandle, CouncilChatInterfaceProps>(({
  conversation,
  availableModels,
  onUpdateConversation,
  memoryContent,
}, ref) => {
  const [input, setInput] = useState('');
  const [hasSubmittedFirst, setHasSubmittedFirst] = useState(conversation.messages.length > 0);
  const [showModelsDropdown, setShowModelsDropdown] = useState(false);
  const [currentUserMessage, setCurrentUserMessage] = useState<string | null>(null);
  const [collapsedExchanges, setCollapsedExchanges] = useState<Set<number>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get the ModelInfo objects for the council members and chairman
  // conversation.council.councilMembers and chairman are in "provider/model-id" format, same as model.key
  const councilMembers = conversation.council?.councilMembers.map(modelString => {
    return availableModels.find(am => am.key === modelString);
  }).filter((m): m is ModelInfo => m !== undefined) || [];

  const chairman = conversation.council?.chairman
    ? availableModels.find(am => am.key === conversation.council!.chairman)
    : undefined;

  const systemPrompt = skillRegistry.buildSystemPrompt({
    id: conversation.id,
    title: conversation.title,
  }, memoryContent);

  const {
    memberContents,
    memberToolUses,
    memberStatuses,
    memberErrors,
    chairmanContent,
    chairmanToolUses,
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

  useAutoResizeTextarea(textareaRef, input);
  useGlobalEscape(stopAll, isAnyStreaming);
  useClickOutside(dropdownRef, () => setShowModelsDropdown(false), showModelsDropdown);

  const { setShouldAutoScroll, handleScroll } = useAutoScroll({
    endRef: messagesEndRef,
    dependencies: [conversation.messages, memberContents, chairmanContent, isAnyStreaming],
  });

  // Clear current user message when streaming ends
  useEffect(() => {
    if (!isAnyStreaming) {
      setCurrentUserMessage(null);
    }
  }, [isAnyStreaming]);

  const doSubmit = useCallback(async () => {
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

    // Add council member responses using content from response objects
    // (don't use memberContents state - it may be stale due to closure)
    // response.model is already in "provider/model-id" format
    const memberMessages: Message[] = result.memberResponses.map((response) => ({
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: response.content,
      model: response.model,
      councilMember: true,
      toolUse: response.toolUse,
      skillUse: response.skillUse,
    }));

    // Add chairman response using content from response object
    // (don't use chairmanContent state - it may be stale due to closure)
    // result.chairmanResponse.model is already in "provider/model-id" format
    const chairmanMessage: Message = {
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: result.chairmanResponse.content,
      model: result.chairmanResponse.model,
      chairman: true,
      toolUse: result.chairmanResponse.toolUse,
      skillUse: result.chairmanResponse.skillUse,
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
  }, [input, isAnyStreaming, chairman, conversation, onUpdateConversation, startCouncilStreaming, councilMembers, setShouldAutoScroll]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const handleKeyDown = useChatKeyboard({
    onSubmit: doSubmit,
    onStop: stopAll,
    isStreaming: isAnyStreaming,
  });

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
                    <MarkdownContent content={group.userMessage} />
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
                        <AgentResponseView
                          key={respIndex}
                          content={response.content}
                          status="complete"
                          toolUses={response.toolUse}
                          skillUses={response.skillUse}
                          headerContent={getModelDisplayName(response, respIndex, councilMembers, conversation.council?.councilMembers)}
                          className="council-member-response"
                        />
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
                    <AgentResponseView
                      content={group.chairmanResponse.content}
                      status="complete"
                      toolUses={group.chairmanResponse.toolUse}
                      skillUses={group.chairmanResponse.skillUse}
                      showHeader={false}
                      className="chairman-content-wrapper"
                    />
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
                    <MarkdownContent content={currentUserMessage} />
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
                    {councilMembers.map((model) => (
                      <AgentResponseView
                        key={model.key}
                        content={memberContents.get(model.key) || ''}
                        status={memberStatuses.get(model.key) || 'pending'}
                        error={memberErrors.get(model.key)}
                        toolUses={memberToolUses.get(model.key) || []}
                        modelName={model.name}
                        className="council-member-response"
                      />
                    ))}
                  </div>
                </div>

                {/* Streaming chairman response */}
                {(currentPhase === 'synthesis' || currentPhase === 'complete') && (
                  <AgentResponseView
                    content={chairmanContent}
                    status={chairmanStatus === 'idle' ? 'pending' : chairmanStatus}
                    error={chairmanError || undefined}
                    toolUses={chairmanToolUses}
                    className="chairman-response"
                    pendingText="Preparing synthesis..."
                    headerContent={
                      <>
                        <span className="chairman-icon">👑</span>
                        <span className="chairman-label">{chairmanName}</span>
                      </>
                    }
                  />
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
            {...TEXTAREA_PROPS}
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
                {councilMembers.map((model) => {
                  const provider = getProviderFromModel(model.key);
                  return (
                    <div key={model.key} className="council-model-item">
                      <span className="council-model-name">{model.name}</span>
                      <span className={`council-model-provider provider-${provider}`}>
                        {PROVIDER_NAMES[provider]}
                      </span>
                    </div>
                  );
                })}
                <div className="dropdown-section-header chairman">
                  <span className="chairman-icon">👑</span> Chairman
                </div>
                {chairman && (() => {
                  const provider = getProviderFromModel(chairman.key);
                  return (
                    <div className="council-model-item chairman-item">
                      <span className="council-model-name">{chairman.name}</span>
                      <span className={`council-model-provider provider-${provider}`}>
                        {PROVIDER_NAMES[provider]}
                      </span>
                    </div>
                  );
                })()}
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
  model?: string;  // Format: "provider/model-id"
  toolUse?: import('../types').ToolUse[];
  skillUse?: import('../types').SkillUse[];
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
          model: messages[j].model,
          toolUse: messages[j].toolUse,
          skillUse: messages[j].skillUse,
        });
        j++;
      }

      // Collect chairman response
      if (j < messages.length && messages[j].role === 'assistant' && messages[j].chairman) {
        chairmanResponse = {
          content: messages[j].content,
          model: messages[j].model,
          toolUse: messages[j].toolUse,
          skillUse: messages[j].skillUse,
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
  conversationModels?: string[]  // In "provider/model-id" format
): string {
  if (response.model) {
    // response.model is in "provider/model-id" format, same as model.key
    const matchedModel = councilMembers.find(m => m.key === response.model);
    if (matchedModel) return matchedModel.name;
    return response.model;
  }

  if (conversationModels && conversationModels[index]) {
    const modelString = conversationModels[index];
    const matchedModel = councilMembers.find(m => m.key === modelString);
    if (matchedModel) return matchedModel.name;
    return getModelIdFromModel(modelString);
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
  conversationChairman?: string  // Now in "provider/model-id" format
): string {
  if (chairman) {
    return chairman.name;
  }

  if (response.model) {
    return response.model;
  }

  if (conversationChairman) {
    return conversationChairman;
  }

  return 'Chairman';
}
