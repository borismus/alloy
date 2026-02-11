import React, { useState } from 'react';
import { SubagentResponse, SubagentStreamingState, getModelIdFromModel } from '../types';
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

const SubagentCellHeader: React.FC<{
  name: string;
  model: string;
  prompt?: string;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ name, model, prompt, isExpanded, onToggle }) => (
  <div className="subagent-cell-header-wrapper">
    <div className="subagent-cell-header" onClick={onToggle} title="Click for details">
      <span className="subagent-cell-name">{name}</span>
      <span className="subagent-cell-model">{getModelIdFromModel(model)}</span>
    </div>
    {isExpanded && (
      <div className="subagent-info-panel">
        <div className="subagent-info-row">
          <span className="subagent-info-label">Model</span>
          <span className="subagent-info-value">{model}</span>
        </div>
        {prompt && (
          <div className="subagent-info-row">
            <span className="subagent-info-label">Prompt</span>
            <span className="subagent-info-value">{prompt}</span>
          </div>
        )}
      </div>
    )}
  </div>
);

/**
 * Renders sub-agent responses in a grid layout.
 * Used both during streaming (with activeSubagents) and for completed messages (with completedResponses).
 */
export const SubagentResponsesView: React.FC<SubagentResponsesViewProps> = ({
  activeSubagents,
  completedResponses,
  onNavigateToNote,
  onNavigateToConversation,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpanded = (id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  };

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
              showHeader={true}
              headerContent={
                <SubagentCellHeader
                  name={agent.name}
                  model={agent.model}
                  prompt={agent.prompt}
                  isExpanded={expandedId === id}
                  onToggle={() => toggleExpanded(id)}
                />
              }
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
          {completedResponses.map((response, index) => {
            const id = `completed-${index}`;
            return (
              <AgentResponseView
                key={index}
                content={response.content}
                status="complete"
                toolUses={response.toolUse}
                skillUses={response.skillUse}
                showHeader={true}
                headerContent={
                  <SubagentCellHeader
                    name={response.name}
                    model={response.model}
                    prompt={response.prompt}
                    isExpanded={expandedId === id}
                    onToggle={() => toggleExpanded(id)}
                  />
                }
                onNavigateToNote={onNavigateToNote}
                onNavigateToConversation={onNavigateToConversation}
              />
            );
          })}
        </div>
      </div>
    );
  }

  return null;
};
