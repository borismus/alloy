import { useState, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Conversation, ModelInfo, Message } from '../types';
import { useCouncilStreaming, CouncilPhase } from '../hooks/useCouncilStreaming';
import { useMultiModelChat } from '../hooks/useMultiModelChat';
import { skillRegistry } from '../services/skills';
import { AgentResponseView } from './AgentResponseView';
import { MarkdownContent } from './MarkdownContent';
import { MultiModelInputForm } from './MultiModelInputForm';
import { ModelDropdownItem } from './ModelDropdownItem';
import { getModelDisplayName, getChairmanDisplayName, ResponseWithModel } from '../utils/models';
import './ChatInterface.css';
import './CouncilChatInterface.css';

interface CouncilChatInterfaceProps {
  conversation: Conversation;
  availableModels: ModelInfo[];
  onUpdateConversation: (conversation: Conversation) => void;
  memoryContent?: string;
}

export interface CouncilChatInterfaceHandle {
  focusInput: () => void;
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

function getPhaseLabel(phase: CouncilPhase): string {
  switch (phase) {
    case 'idle': return 'Ready';
    case 'individual': return 'Council deliberating...';
    case 'synthesis': return 'Chairman synthesizing...';
    case 'complete': return 'Complete';
  }
}

export const CouncilChatInterface = forwardRef<CouncilChatInterfaceHandle, CouncilChatInterfaceProps>(({
  conversation,
  availableModels,
  onUpdateConversation,
  memoryContent,
}, ref) => {
  const [collapsedExchanges, setCollapsedExchanges] = useState<Set<number>>(new Set());

  // Get the ModelInfo objects for the council members and chairman
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

  const {
    input,
    setInput,
    hasSubmittedFirst,
    showModelsDropdown,
    setShowModelsDropdown,
    currentUserMessage,
    textareaRef,
    dropdownRef,
    messagesContainerRef,
    messagesEndRef,
    handleScroll,
    focusInput,
    prepareSubmit,
  } = useMultiModelChat({
    conversationId: conversation.id,
    hasMessages: conversation.messages.length > 0,
    isAnyStreaming,
    stopAll,
    autoScrollDependencies: [conversation.messages, memberContents, chairmanContent, isAnyStreaming],
  });

  useImperativeHandle(ref, () => ({ focusInput }));

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

  const doSubmit = useCallback(async () => {
    if (!input.trim() || isAnyStreaming || !chairman) return;

    const userMessage = input.trim();
    prepareSubmit(userMessage);

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
    const memberMessages: Message[] = result.memberResponses.map((response) => ({
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: response.content,
      model: response.model,
      councilMember: true,
      toolUse: response.toolUse,
      skillUse: response.skillUse,
    }));

    // Add chairman response
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
  }, [input, isAnyStreaming, chairman, conversation, onUpdateConversation, startCouncilStreaming, councilMembers, prepareSubmit]);

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

      <MultiModelInputForm
        input={input}
        onInputChange={setInput}
        onSubmit={doSubmit}
        onStop={stopAll}
        isStreaming={isAnyStreaming}
        placeholder="Ask the council..."
        textareaRef={textareaRef}
        dropdownRef={dropdownRef}
        showDropdown={showModelsDropdown}
        onToggleDropdown={() => setShowModelsDropdown(!showModelsDropdown)}
        dropdownClassName="council-model-indicator-wrapper"
        dropdownButtonContent={<>{councilMembers.length}+1</>}
        dropdownContent={
          <div className="council-models-dropdown">
            <div className="dropdown-section-header">Council Members</div>
            {councilMembers.map((model) => (
              <ModelDropdownItem key={model.key} model={model} className="council-model-item" />
            ))}
            <div className="dropdown-section-header chairman">
              <span className="chairman-icon">👑</span> Chairman
            </div>
            {chairman && (
              <ModelDropdownItem model={chairman} className="council-model-item chairman-item" />
            )}
          </div>
        }
      />
    </div>
  );
});
