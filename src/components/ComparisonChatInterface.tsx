import { forwardRef, useImperativeHandle, useCallback } from 'react';
import { Conversation, ModelInfo, ComparisonResponse } from '../types';
import { useComparisonStreaming } from '../hooks/useComparisonStreaming';
import { useMultiModelChat } from '../hooks/useMultiModelChat';
import { skillRegistry } from '../services/skills';
import { AgentResponseView } from './AgentResponseView';
import { MarkdownContent } from './MarkdownContent';
import { MultiModelInputForm } from './MultiModelInputForm';
import { ModelDropdownItem } from './ModelDropdownItem';
import { getModelDisplayName, ResponseWithModel } from '../utils/models';
import './ChatInterface.css';

interface ComparisonChatInterfaceProps {
  conversation: Conversation;
  availableModels: ModelInfo[];
  onUpdateConversation: (conversation: Conversation) => void;
  memoryContent?: string;
}

export interface ComparisonChatInterfaceHandle {
  focusInput: () => void;
}

export const ComparisonChatInterface = forwardRef<ComparisonChatInterfaceHandle, ComparisonChatInterfaceProps>(({
  conversation,
  availableModels,
  onUpdateConversation,
  memoryContent,
}, ref) => {
  // Get the ModelInfo objects for the comparison models
  const comparisonModels = conversation.comparison?.models.map(modelString => {
    return availableModels.find(am => am.key === modelString);
  }).filter((m): m is ModelInfo => m !== undefined) || [];

  const systemPrompt = skillRegistry.buildSystemPrompt({
    id: conversation.id,
    title: conversation.title,
  }, memoryContent);

  const {
    streamingContents,
    streamingToolUses,
    statuses,
    errors,
    startStreaming,
    stopAll,
    isAnyStreaming,
  } = useComparisonStreaming({
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
    autoScrollDependencies: [conversation.messages, streamingContents, isAnyStreaming],
  });

  useImperativeHandle(ref, () => ({ focusInput }));

  const doSubmit = useCallback(async () => {
    if (!input.trim() || isAnyStreaming) return;

    const userMessage = input.trim();
    prepareSubmit(userMessage);

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

    // Add responses to conversation using content from response objects
    // (don't use streamingContents state - it may be stale due to closure)
    // response.model is already in "provider/model-id" format
    const assistantMessages = responses.map((response: ComparisonResponse) => ({
      role: 'assistant' as const,
      timestamp: new Date().toISOString(),
      content: response.content,
      model: response.model,
      toolUse: response.toolUse,
      skillUse: response.skillUse,
    }));

    const finalConversation = {
      ...updatedConversation,
      messages: [...updatedConversation.messages, ...assistantMessages],
    };
    onUpdateConversation(finalConversation);
  }, [input, isAnyStreaming, conversation, onUpdateConversation, startStreaming, comparisonModels, prepareSubmit]);

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
                    <MarkdownContent content={group.userMessage} />
                  </div>
                </div>
                <div className="comparison-responses-summary">
                  {group.responses.map((response, respIndex) => (
                    <AgentResponseView
                      key={respIndex}
                      content={response.content}
                      status="complete"
                      toolUses={response.toolUse}
                      skillUses={response.skillUse}
                      headerContent={getModelDisplayName(response, respIndex, comparisonModels, conversation.comparison?.models)}
                    />
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
                    <MarkdownContent content={currentUserMessage} />
                  </div>
                </div>
                <div className="comparison-responses-summary">
                  {comparisonModels.map((model) => (
                    <AgentResponseView
                      key={model.key}
                      content={streamingContents.get(model.key) || ''}
                      status={statuses.get(model.key) || 'pending'}
                      error={errors.get(model.key)}
                      toolUses={streamingToolUses.get(model.key) || []}
                      modelName={model.name}
                    />
                  ))}
                </div>
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
        placeholder="Send a message to compare..."
        textareaRef={textareaRef}
        dropdownRef={dropdownRef}
        showDropdown={showModelsDropdown}
        onToggleDropdown={() => setShowModelsDropdown(!showModelsDropdown)}
        dropdownButtonContent={<>{comparisonModels.length} models</>}
        dropdownContent={
          <div className="comparison-models-dropdown">
            {comparisonModels.map((model) => (
              <ModelDropdownItem key={model.key} model={model} />
            ))}
          </div>
        }
      />
    </div>
  );
});

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
            model: nextMsg.model,
            toolUse: nextMsg.toolUse,
            skillUse: nextMsg.skillUse,
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
