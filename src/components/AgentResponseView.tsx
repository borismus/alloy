import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ToolUse, SkillUse } from '../types';
import { ToolUseIndicator } from './ToolUseIndicator';
import { SkillUseIndicator } from './SkillUseIndicator';

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

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

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
}

/**
 * A reusable component for displaying an agent's streaming response.
 * Handles tool/skill indicators, loading states, and markdown rendering.
 * Used across regular chat, comparison, and council modes.
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
          <ToolUseIndicator toolUse={displayedToolUses} isStreaming={isStreaming} />
        )}
        {status === 'pending' && (
          <span className="waiting-text">{pendingText}</span>
        )}
        {isStreaming && !content && (
          <div className="thinking-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
        {content && (
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
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
};
