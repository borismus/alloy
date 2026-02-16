import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Message } from '../types';
import { AgentResponseView } from './AgentResponseView';
import { MarkdownContent } from './MarkdownContent';
import { useBackgroundContext, BackgroundTask } from '../contexts/BackgroundContext';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
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
    sendMessage,
  } = useBackgroundContext();

  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const messages = conversation?.messages || [];

  // Scroll to specific message when navigating from provenance links
  useScrollToMessage({
    containerRef: messagesContainerRef,
    messageId: scrollToMessageId,
    onScrollComplete,
  });

  // Auto-scroll to bottom when new messages/tasks arrive (skip if scrolling to a specific message)
  useEffect(() => {
    if (scrollToMessageId) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, tasks]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setInputValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [inputValue, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  // Focus input on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Find active (running) tasks for streaming display
  const runningTasks = tasks.filter(t => t.status === 'running');

  return (
    <div className="background-view">
      <div className="background-messages" ref={messagesContainerRef}>
        {messages.length === 0 && runningTasks.length === 0 ? (
          <div className="background-empty">
            <h2>Wheelhouse</h2>
            <p>Type a command, ask a question, or think out loud. Work gets delegated to background agents automatically.</p>
          </div>
        ) : (
          <>
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

      <div className="background-input">
        <div className="background-input-row">
          <span className="background-prompt-char">&gt;</span>
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            rows={1}
          />
          <button
            className="background-send-btn"
            onClick={handleSubmit}
            disabled={!inputValue.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

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
      />
    </div>
  );
};

/**
 * Shows a currently-running task with streaming content.
 */
const StreamingTaskView: React.FC<{
  task: BackgroundTask;
  onNavigateToNote: (filename: string) => void;
  onNavigateToConversation: (conversationId: string, messageId?: string) => void;
}> = ({ task, onNavigateToNote, onNavigateToConversation }) => {
  return (
    <div className="background-streaming-task">
      <div className="background-task-streaming-label">
        <span className="task-spinner" />
        {task.name}
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
