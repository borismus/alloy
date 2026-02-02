import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Message, ToolUse } from '../types';
import { AgentResponseView } from './AgentResponseView';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import { useScrollToMessageCallback } from '../hooks/useScrollToMessage';
import './ChatInterface.css';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

interface UserMessageProps {
  message: Message;
  getImageUrl?: (path: string) => string | undefined;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string) => void;
  compact?: boolean;
}

const UserMessage = React.memo(({
  message,
  getImageUrl,
  onNavigateToNote,
  onNavigateToConversation,
  compact
}: UserMessageProps) => {
  const processedContent = useMemo(() => processWikiLinks(message.content), [message.content]);
  const markdownComponents = useMemo(
    () => createMarkdownComponents({ onNavigateToNote, onNavigateToConversation }),
    [onNavigateToNote, onNavigateToConversation]
  );

  return (
    <div className={`message user ${compact ? 'compact' : ''}`}>
      <div className="message-content">
        {getImageUrl && message.attachments?.filter(a => a.type === 'image').map((attachment) => {
          const url = getImageUrl(attachment.path);
          return (
            <div key={attachment.path} className="message-image">
              {url && <img src={url} alt="Attachment" />}
            </div>
          );
        })}
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
          {processedContent}
        </ReactMarkdown>
      </div>
    </div>
  );
});

const LogMessage = React.memo(({ message }: { message: Message }) => (
  <div className="message log">
    <div className="log-content">{message.content}</div>
  </div>
));

export interface ConversationViewProps {
  messages: Message[];
  streamingContent?: string;
  streamingToolUse?: ToolUse[];
  isStreaming?: boolean;
  assistantName?: string;
  showHeader?: boolean;
  compact?: boolean;
  getImageUrl?: (path: string) => string | undefined;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string) => void;
  emptyState?: React.ReactNode;
  className?: string;
}

export interface ConversationViewHandle {
  scrollToBottom: () => void;
  scrollToMessage: (messageId: string) => void;
}

export const ConversationView = React.forwardRef<ConversationViewHandle, ConversationViewProps>(({
  messages,
  streamingContent = '',
  streamingToolUse = [],
  isStreaming = false,
  assistantName = 'Assistant',
  showHeader = true,
  compact = false,
  getImageUrl,
  onNavigateToNote,
  onNavigateToConversation,
  emptyState,
  className = '',
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((smooth = true) => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    }
  }, []);

  // Scroll to specific message by ID
  const scrollToMessage = useScrollToMessageCallback(containerRef);

  // Expose methods via ref
  React.useImperativeHandle(ref, () => ({
    scrollToBottom: () => scrollToBottom(true),
    scrollToMessage,
  }), [scrollToBottom, scrollToMessage]);

  // Reset auto-scroll when streaming starts
  useEffect(() => {
    if (isStreaming) {
      shouldAutoScrollRef.current = true;
    }
  }, [isStreaming]);

  // Auto-scroll on new messages or streaming
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      // Use instant scroll during streaming to avoid animation conflicts
      scrollToBottom(!isStreaming);
    }
  }, [messages, streamingContent, isStreaming, scrollToBottom]);

  // Track scroll position for auto-scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const threshold = 50;
    const isNearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
    shouldAutoScrollRef.current = isNearBottom;
  }, []);

  // Determine if we should show streaming message
  // Show when actively streaming OR when we have content that hasn't been added to messages yet
  const showStreamingMessage = isStreaming || !!streamingContent;

  // Memoize rendered messages
  const renderedMessages = useMemo(() => {
    return messages.map((message, index) => {
      // Skip last assistant message if it matches streaming content (about to be replaced)
      const isLastMessage = index === messages.length - 1;
      if (isLastMessage && message.role === 'assistant' && streamingContent && message.content === streamingContent) {
        return null;
      }

      if (message.role === 'log') {
        return <LogMessage key={index} message={message} />;
      }

      if (message.role === 'user') {
        return (
          <div key={index} data-message-id={message.id}>
            <UserMessage
              message={message}
              getImageUrl={getImageUrl}
              onNavigateToNote={onNavigateToNote}
              onNavigateToConversation={onNavigateToConversation}
              compact={compact}
            />
          </div>
        );
      }

      // Assistant message
      return (
        <div key={index} data-message-id={message.id}>
          <AgentResponseView
            content={message.content}
            status="complete"
            toolUses={message.toolUse}
            skillUses={message.skillUse}
            onNavigateToNote={onNavigateToNote}
            onNavigateToConversation={onNavigateToConversation}
            headerContent={showHeader ? assistantName : undefined}
            showHeader={showHeader}
            className={compact ? 'compact' : ''}
          />
        </div>
      );
    });
  }, [messages, streamingContent, getImageUrl, onNavigateToNote, onNavigateToConversation, showHeader, assistantName, compact]);

  const isEmpty = messages.length === 0 && !showStreamingMessage;

  return (
    <div
      className={`conversation-view ${compact ? 'compact' : ''} ${className}`}
      ref={containerRef}
      onScroll={handleScroll}
    >
      {isEmpty && emptyState}

      {renderedMessages}

      {showStreamingMessage && (
        <AgentResponseView
          content={streamingContent}
          status={isStreaming ? 'streaming' : 'pending'}
          toolUses={streamingToolUse}
          headerContent={showHeader ? assistantName : undefined}
          showHeader={showHeader}
          onNavigateToNote={onNavigateToNote}
          onNavigateToConversation={onNavigateToConversation}
          className={compact ? 'compact' : ''}
        />
      )}

      <div ref={endRef} />
    </div>
  );
});
