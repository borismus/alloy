import React from 'react';
import { ToolUse, SkillUse, Usage } from '../types';
import { ToolUseIndicator } from './ToolUseIndicator';
import { SkillUseIndicator } from './SkillUseIndicator';
import { MarkdownContent } from './MarkdownContent';
import { ThinkingDisclosure } from './ThinkingDisclosure';
import { CopyButton } from './ui';

export type AgentStatus = 'pending' | 'streaming' | 'complete' | 'error';

/** Compact latency for the footer: "820ms", "12.3s", "1m 5s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

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
  /** Ephemeral provider-supplied reasoning for the active stream. */
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingElapsedMs?: number;
  thinkingDurationMs?: number;
  /** Token usage and cost for this response */
  usage?: Usage;
  /**
   * Stable code set by the backend when the turn produced a real answer but had
   * to stop short of finishing its work. Rendered as a notice above the footer
   * so a partial answer is never mistaken for a complete one.
   */
  incompleteReason?: string;
}

/** Wording for each `incompleteReason`. Unknown codes get a neutral fallback. */
function incompleteNotice(reason: string): string {
  switch (reason) {
    case 'context_budget':
      return 'Stopped early \u2014 this turn reached the model\u2019s context limit, so the answer '
        + 'uses only what it gathered before that point.';
    case 'output_limit':
      return 'Cut off \u2014 the model reached its maximum reply length, so this answer stops '
        + 'mid-thought. Ask it to continue.';
    case 'iteration_limit':
      return 'Stopped early \u2014 this turn reached Alloy\u2019s tool-use safety limit, so the answer '
        + 'uses only what it gathered before that point.';
    default:
      return 'Stopped early \u2014 this answer may be based on incomplete work.';
  }
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
  thinking = '',
  thinkingStartedAt,
  thinkingElapsedMs,
  thinkingDurationMs,
  usage,
  incompleteReason,
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
        {isStreaming && thinkingStartedAt != null &&
         (thinkingDurationMs == null || thinking.trim().length > 0) && (
          <ThinkingDisclosure
            key={`${thinkingDurationMs == null ? 'active' : 'finished'}-${thinkingStartedAt}`}
            thinking={thinking}
            startedAt={thinkingStartedAt}
            initialElapsedMs={thinkingElapsedMs ?? 0}
            durationMs={thinkingDurationMs}
            active={thinkingDurationMs == null}
          />
        )}
        {content && (
          <MarkdownContent
            content={content}
            onNavigateToNote={onNavigateToNote}
            onNavigateToConversation={onNavigateToConversation}
          />
        )}
        {status === 'complete' && content && incompleteReason && (
          <p className="response-incomplete-notice" role="note">
            {incompleteNotice(incompleteReason)}
          </p>
        )}
        {status === 'complete' && content && (
          <div className="response-footer">
            {usage?.durationMs != null && (
              <span className="latency-badge" title="Response time">{formatDuration(usage.durationMs)}</span>
            )}
            {usage && (
              <div className="usage-badge">
                {usage.cost !== undefined && (
                  <span>${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}</span>
                )}
                {' '}
                <span>{((usage.inputTokens + (usage.cachedInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + usage.outputTokens) / 1000).toFixed(1)}k tok</span>
              </div>
            )}
            <CopyButton text={content} label="Copy markdown" />
          </div>
        )}
        {status === 'error' && (
          <span className="error-text">{error || 'An error occurred'}</span>
        )}
      </div>
    </div>
  );
};
