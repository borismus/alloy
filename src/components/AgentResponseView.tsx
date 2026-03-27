import React, { useState, useCallback } from 'react';
import { ToolUse, SkillUse, Usage } from '../types';
import { ToolUseIndicator } from './ToolUseIndicator';
import { SkillUseIndicator } from './SkillUseIndicator';
import { MarkdownContent } from './MarkdownContent';

export type AgentStatus = 'pending' | 'streaming' | 'complete' | 'error';

interface AgentResponseViewProps {
  /** The streaming/completed content */
  content: string;
  /** Current status of the agent */
  status: AgentStatus;
  /** Error message if status is 'error' */
  error?: string;
  /** Tool uses during this response */
  toolUses?: ToolUse[];
  /** Skill uses during this response (if not provided, derived from toolUses) */
  skillUses?: SkillUse[];
  /** Optional model name for header display */
  modelName?: string;
  /** Whether to show the header (model name + streaming indicator) */
  showHeader?: boolean;
  /** Text to show while pending (default: "Waiting...") */
  pendingText?: string;
  /** Additional CSS class for the container */
  className?: string;
  /** Custom header content (overrides modelName) */
  headerContent?: React.ReactNode;
  /** Callback when a wiki-link to a note is clicked */
  onNavigateToNote?: (noteFilename: string) => void;
  /** Callback when a wiki-link to a conversation is clicked */
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  /** Token usage and cost for this response */
  usage?: Usage;
}

/**
 * A reusable component for displaying an agent's streaming response.
 * Handles tool/skill indicators, loading states, and markdown rendering.
 */
export const AgentResponseView: React.FC<AgentResponseViewProps> = ({
  content,
  status,
  error,
  toolUses = [],
  skillUses: skillUsesProp,
  modelName,
  showHeader = true,
  pendingText = 'Waiting...',
  className = '',
  headerContent,
  onNavigateToNote,
  onNavigateToConversation,
  usage,
}) => {
  // Use provided skillUses, or derive from use_skill tool calls
  const skillUses: SkillUse[] = skillUsesProp ?? toolUses
    .filter(t => t.type === 'use_skill')
    .map(t => ({ name: (t.input?.name as string) || 'skill' }));

  // Filter out use_skill from displayed tools
  const displayedToolUses = toolUses.filter(t => t.type !== 'use_skill');

  const isStreaming = status === 'streaming';
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className={`response-summary status-${status} ${className}`}>
      {showHeader && (
        <div className="response-summary-header">
          {headerContent || modelName}
          {isStreaming && <span className="streaming-indicator" />}
        </div>
      )}
      <div className="response-summary-content">
        {skillUses.length > 0 && (
          <SkillUseIndicator skillUse={skillUses} />
        )}
        {displayedToolUses.length > 0 && (
          <ToolUseIndicator
            toolUse={displayedToolUses}
            isStreaming={isStreaming}
            onNavigateToNote={onNavigateToNote}
          />
        )}
        {status === 'pending' && (
          <span className="waiting-text">{pendingText}</span>
        )}
        {isStreaming && !content.trim() && (
          <div className="thinking-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
        {content && (
          <MarkdownContent
            content={content}
            onNavigateToNote={onNavigateToNote}
            onNavigateToConversation={onNavigateToConversation}
          />
        )}
        {status === 'complete' && content && (
          <div className="response-footer">
            {usage && (
              <div className="usage-badge">
                {usage.cost !== undefined && (
                  <span>${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}</span>
                )}
                {' '}
                <span>{((usage.inputTokens + usage.outputTokens) / 1000).toFixed(1)}k tok</span>
              </div>
            )}
            <button className={`copy-response-button ${copied ? 'copied' : ''}`} onClick={handleCopy} title="Copy markdown">
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        )}
        {status === 'error' && (
          <span className="error-text">{error || 'An error occurred'}</span>
        )}
      </div>
    </div>
  );
};
