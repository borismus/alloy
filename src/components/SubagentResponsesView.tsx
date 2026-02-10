import React from 'react';
import { SubagentResponse, SubagentStreamingState } from '../types';
import { AgentResponseView, AgentStatus } from './AgentResponseView';
import './SubagentResponsesView.css';

interface SubagentResponsesViewProps {
  /** Active sub-agents during streaming (from StreamingContext) */
  activeSubagents?: Map<string, SubagentStreamingState> | null;
  /** Completed sub-agent responses (from message) */
  completedResponses?: SubagentResponse[];
  /** Callback when a wiki-link to a note is clicked */
  onNavigateToNote?: (noteFilename: string) => void;
  /** Callback when a wiki-link to a conversation is clicked */
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
}

/**
 * Renders sub-agent responses in a comparison-style grid.
 * Used both during streaming (with activeSubagents) and for completed messages (with completedResponses).
 */
export const SubagentResponsesView: React.FC<SubagentResponsesViewProps> = ({
  activeSubagents,
  completedResponses,
  onNavigateToNote,
  onNavigateToConversation,
}) => {
  // Render active streaming sub-agents
  if (activeSubagents && activeSubagents.size > 0) {
    const agents = Array.from(activeSubagents.entries());
    return (
      <div className="subagent-container">
        <div className="subagent-header">
          <span className="subagent-icon">&#x2726;</span>
          <span>Sub-agents ({agents.length})</span>
        </div>
        <div className="subagent-responses-grid">
          {agents.map(([id, agent]) => (
            <AgentResponseView
              key={id}
              content={agent.content}
              status={agent.status as AgentStatus}
              error={agent.error}
              toolUses={agent.toolUse}
              modelName={agent.name}
              showHeader={true}
              onNavigateToNote={onNavigateToNote}
              onNavigateToConversation={onNavigateToConversation}
            />
          ))}
        </div>
      </div>
    );
  }

  // Render completed sub-agent responses
  if (completedResponses && completedResponses.length > 0) {
    return (
      <div className="subagent-container">
        <div className="subagent-header">
          <span className="subagent-icon">&#x2726;</span>
          <span>Sub-agents ({completedResponses.length})</span>
        </div>
        <div className="subagent-responses-grid">
          {completedResponses.map((response, index) => (
            <AgentResponseView
              key={index}
              content={response.content}
              status="complete"
              toolUses={response.toolUse}
              skillUses={response.skillUse}
              modelName={response.name}
              showHeader={true}
              onNavigateToNote={onNavigateToNote}
              onNavigateToConversation={onNavigateToConversation}
            />
          ))}
        </div>
      </div>
    );
  }

  return null;
};
