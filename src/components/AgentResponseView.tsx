import React from 'react';
import { ToolUse, SkillUse } from '../types';
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
}) => {
  // Use provided skillUses, or derive from use_skill tool calls
  const skillUses: SkillUse[] = skillUsesProp ?? toolUses
    .filter(t => t.type === 'use_skill')
    .map(t => ({ name: (t.input?.name as string) || 'skill' }));

  // Filter out use_skill from displayed tools
  const displayedToolUses = toolUses.filter(t => t.type !== 'use_skill');

  const isStreaming = status === 'streaming';

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
        {status === 'error' && (
          <span className="error-text">{error || 'An error occurred'}</span>
        )}
      </div>
    </div>
  );
};
