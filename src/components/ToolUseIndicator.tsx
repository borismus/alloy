import React from 'react';
import { ToolUse } from '../types';
import './ToolUseIndicator.css';

interface ToolUseIndicatorProps {
  toolUse: ToolUse[];
  isStreaming?: boolean;
}

const TOOL_LABELS: Record<string, { active: string; complete: string }> = {
  web_search: { active: 'Searching the web', complete: 'Searched the web' },
};

export const ToolUseIndicator: React.FC<ToolUseIndicatorProps> = ({
  toolUse,
  isStreaming = false
}) => {
  if (toolUse.length === 0) return null;

  return (
    <div className="tool-use-indicators">
      {toolUse.map((tool, idx) => {
        const labels = TOOL_LABELS[tool.type] || { active: tool.type, complete: tool.type };
        const label = isStreaming ? labels.active : labels.complete;

        return (
          <div key={idx} className="tool-use-indicator">
            <span className="tool-use-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </span>
            <span className="tool-use-label">{label}</span>
            {isStreaming && <span className="tool-use-spinner" />}
          </div>
        );
      })}
    </div>
  );
};
