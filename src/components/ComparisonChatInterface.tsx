import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Conversation, ModelInfo, ComparisonResponse, ProviderType, getProviderFromModel, getModelIdFromModel } from '../types';
import { useComparisonStreaming } from '../hooks/useComparisonStreaming';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useGlobalEscape } from '../hooks/useGlobalEscape';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useClickOutside } from '../hooks/useClickOutside';
import { TEXTAREA_PROPS } from '../utils/textareaProps';
import { skillRegistry } from '../services/skills';
import { AgentResponseView } from './AgentResponseView';
import { MarkdownContent } from './MarkdownContent';
import './ChatInterface.css';

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

interface ComparisonChatInterfaceProps {
  conversation: Conversation;
  availableModels: ModelInfo[];
  onUpdateConversation: (conversation: Conversation) => void;
  memoryContent?: string;
}

export interface ComparisonChatInterfaceHandle {
  focusInput: () => void;
}

// Use model.key directly - no need for helper function

export const ComparisonChatInterface = forwardRef<ComparisonChatInterfaceHandle, ComparisonChatInterfaceProps>(({
  conversation,
  availableModels,
  onUpdateConversation,
  memoryContent,
}, ref) => {
  const [input, setInput] = useState('');
  const [hasSubmittedFirst, setHasSubmittedFirst] = useState(conversation.messages.length > 0);
  const [showModelsDropdown, setShowModelsDropdown] = useState(false);
  const [currentUserMessage, setCurrentUserMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get the ModelInfo objects for the comparison models
  // conversation.comparison.models are in "provider/model-id" format, same as model.key
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

  useAutoResizeTextarea(textareaRef, input);
  useGlobalEscape(stopAll, isAnyStreaming);
  useClickOutside(dropdownRef, () => setShowModelsDropdown(false), showModelsDropdown);

  const { setShouldAutoScroll, handleScroll } = useAutoScroll({
    endRef: messagesEndRef,
    dependencies: [conversation.messages, streamingContents, isAnyStreaming],
  });

  // Clear current user message when streaming ends
  useEffect(() => {
    if (!isAnyStreaming) {
      setCurrentUserMessage(null);
    }
  }, [isAnyStreaming]);

  const doSubmit = useCallback(async () => {
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
  }, [input, isAnyStreaming, conversation, onUpdateConversation, startStreaming, comparisonModels, setShouldAutoScroll]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const handleKeyDown = useChatKeyboard({
    onSubmit: doSubmit,
    onStop: stopAll,
    isStreaming: isAnyStreaming,
  });

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
            {...TEXTAREA_PROPS}
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
                {comparisonModels.map((model) => {
                  const provider = getProviderFromModel(model.key);
                  return (
                    <div key={model.key} className="comparison-model-item">
                      <span className="comparison-model-name">{model.name}</span>
                      <span className={`comparison-model-provider provider-${provider}`}>
                        {PROVIDER_NAMES[provider]}
                      </span>
                    </div>
                  );
                })}
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

// Get display name for a model, with fallback
function getModelDisplayName(
  response: ResponseWithModel,
  index: number,
  comparisonModels: ModelInfo[],
  conversationModels?: string[]  // In "provider/model-id" format
): string {
  // First try: look up by model string from the message itself
  if (response.model) {
    // response.model is in "provider/model-id" format, same as model.key
    const matchedModel = comparisonModels.find(m => m.key === response.model);
    if (matchedModel) return matchedModel.name;
    // Model not in availableModels, use raw model string
    return response.model;
  }

  // Fallback: use positional matching with conversation metadata
  if (conversationModels && conversationModels[index]) {
    const modelString = conversationModels[index];
    const matchedModel = comparisonModels.find(m => m.key === modelString);
    if (matchedModel) return matchedModel.name;
    // Return just the model ID part
    return getModelIdFromModel(modelString);
  }

  // Last resort: use comparisonModels by index
  if (comparisonModels[index]) {
    return comparisonModels[index].name;
  }

  return `Model ${index + 1}`;
}
