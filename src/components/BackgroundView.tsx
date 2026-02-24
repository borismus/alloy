import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Message, getProviderFromModel, getModelIdFromModel } from '../types';
import { PROVIDER_NAMES } from '../utils/models';
import { getOrchestratorModel } from '../services/background';
import { AgentResponseView } from './AgentResponseView';
import { MarkdownContent } from './MarkdownContent';
import { useBackgroundContext, BackgroundTask } from '../contexts/BackgroundContext';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useGlobalEscape } from '../hooks/useGlobalEscape';
import { useTextareaProps } from '../utils/textareaProps';
import './BackgroundView.css';

interface BackgroundViewProps {
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
  scrollToMessageId?: string | null;
  onScrollComplete?: () => void;
}

export const BackgroundView: React.FC<BackgroundViewProps> = ({
  onNavigateToNote,
  onNavigateToConversation,
  scrollToMessageId,
  onScrollComplete,
}) => {
  const {
    conversation,
    tasks,
    queueLength,
    cancelTask,
  } = useBackgroundContext();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const messages = conversation?.messages || [];

  // Compute total cost across all messages in the background conversation
  const totalCost = useMemo(() => {
    let cost = 0;
    let counted = 0;
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.usage?.cost !== undefined) {
        cost += msg.usage.cost;
        counted++;
      }
    }
    return counted > 0 ? cost : undefined;
  }, [messages]);

  // Scroll to specific message when navigating from provenance links
  useScrollToMessage({
    containerRef: messagesContainerRef,
    messageId: scrollToMessageId,
    onScrollComplete,
  });

  // Smart auto-scroll: only scrolls when user is near the bottom
  const { handleScroll } = useAutoScroll({
    endRef: messagesEndRef,
    dependencies: [messages, tasks],
  });

  // Find active (running) tasks for streaming display
  const runningTasks = tasks.filter(t => t.status === 'running');

  return (
    <div className="background-view">
      <div className="background-messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {messages.length === 0 && runningTasks.length === 0 ? (
          <div className="background-empty">
            <h2>Alloy</h2>
            <p>Type a command, ask a question, or think out loud. Work gets delegated to background agents automatically.</p>
          </div>
        ) : (
          <>
            {(() => {
              const orchestratorModel = getOrchestratorModel();
              return orchestratorModel || totalCost !== undefined ? (
                <div className="model-info">
                  {orchestratorModel && (
                    <>
                      <span className="model-provider">{PROVIDER_NAMES[getProviderFromModel(orchestratorModel)]}</span>
                      <span className="model-separator">·</span>
                      <span className="model-name">{getModelIdFromModel(orchestratorModel)}</span>
                    </>
                  )}
                  {totalCost !== undefined && (
                    <>
                      {orchestratorModel && <span className="model-separator">·</span>}
                      <span className="model-cost">${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}</span>
                    </>
                  )}
                </div>
              ) : null;
            })()}
            {messages.map((message, index) => (
              <MessageRow
                key={message.id || index}
                message={message}
                onNavigateToNote={onNavigateToNote}
                onNavigateToConversation={onNavigateToConversation}
              />
            ))}

            {/* Show running tasks with streaming content */}
            {runningTasks.map(task => (
              <StreamingTaskView
                key={task.id}
                task={task}
                onCancel={cancelTask}
                onNavigateToNote={onNavigateToNote}
                onNavigateToConversation={onNavigateToConversation}
              />
            ))}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {queueLength > 0 && (
        <div className="background-queue-indicator">
          {queueLength} message{queueLength > 1 ? 's' : ''} queued...
        </div>
      )}

      <BackgroundInputForm />
    </div>
  );
};

/**
 * Isolated input form to prevent keystroke re-renders from propagating to the message list.
 */
const BackgroundInputForm = React.memo(() => {
  const { sendMessage, cancelAllTasks, hasRunningTasks } = useBackgroundContext();
  const [inputValue, setInputValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaProps = useTextareaProps();

  useAutoResizeTextarea(textareaRef, inputValue);

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setInputValue('');
  }, [inputValue, sendMessage]);

  const handleKeyDown = useChatKeyboard({
    onSubmit: handleSubmit,
    onStop: cancelAllTasks,
    isStreaming: hasRunningTasks,
  });

  useGlobalEscape(cancelAllTasks, hasRunningTasks);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="background-input">
      <div className="background-input-row">
        <span className="background-prompt-char">&gt;</span>
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          rows={1}
          {...textareaProps}
        />
        {hasRunningTasks ? (
          <button
            className="background-send-btn background-stop-btn"
            onClick={cancelAllTasks}
            title="Stop all tasks"
          >
            &#9632;
          </button>
        ) : (
          <button
            className="background-send-btn"
            onClick={handleSubmit}
            disabled={!inputValue.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
});

/**
 * Renders a single message in the background conversation.
 * Determines style based on role and content characteristics.
 */
const MessageRow: React.FC<{
  message: Message;
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
}> = ({ message, onNavigateToNote, onNavigateToConversation }) => {
  if (message.role === 'user') {
    return (
      <div className="background-user-message" data-message-id={message.id}>
        <div className="prompt-line">
          <span className="prompt-char">&gt;</span>
          <span className="prompt-text">{message.content}</span>
        </div>
      </div>
    );
  }

  if (message.role === 'log') {
    return null; // Skip log messages in background view
  }

  // Assistant message: orchestrator acks shown inline, task results in cards
  if (message.source !== 'task') {
    return (
      <div className="background-ack-message" data-message-id={message.id}>
        <MarkdownContent content={message.content} />
      </div>
    );
  }

  // Full task result — use AgentResponseView
  return (
    <div className="background-task-result" data-message-id={message.id}>
      <AgentResponseView
        content={message.content}
        status="complete"
        toolUses={message.toolUse}
        skillUses={message.skillUse}
        onNavigateToNote={onNavigateToNote}
        onNavigateToConversation={onNavigateToConversation}
        usage={message.usage}
      />
    </div>
  );
};

/**
 * Shows a currently-running task with streaming content.
 */
const StreamingTaskView: React.FC<{
  task: BackgroundTask;
  onCancel: (taskId: string) => void;
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
}> = ({ task, onCancel, onNavigateToNote, onNavigateToConversation }) => {
  return (
    <div className="background-streaming-task">
      <div className="background-task-streaming-label">
        <span className="task-spinner" />
        {task.name}
        <button
          className="task-cancel-btn"
          onClick={() => onCancel(task.id)}
          title="Cancel task"
        >
          &times;
        </button>
      </div>
      <AgentResponseView
        content={task.content}
        status="streaming"
        toolUses={task.toolUses}
        onNavigateToNote={onNavigateToNote}
        onNavigateToConversation={onNavigateToConversation}
        showHeader={false}
      />
    </div>
  );
};
