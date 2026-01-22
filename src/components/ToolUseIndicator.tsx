import React from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ToolUse } from '../types';
import './ToolUseIndicator.css';

interface ToolUseIndicatorProps {
  toolUse: ToolUse[];
  isStreaming?: boolean;
}

const TOOL_LABELS: Record<string, { active: string; complete: string; icon?: string }> = {
  read_file: { active: 'Reading file', complete: 'Read file', icon: 'file' },
  write_file: { active: 'Writing file', complete: 'Wrote file', icon: 'file' },
  append_file: { active: 'Appending to file', complete: 'Appended to file', icon: 'file' },
  http_get: { active: 'Fetching URL', complete: 'Fetched URL', icon: 'globe' },
  http_post: { active: 'Sending request', complete: 'Sent request', icon: 'globe' },
  get_secret: { active: 'Getting secret', complete: 'Got secret', icon: 'key' },
  web_search: { active: 'Searching', complete: 'Searched', icon: 'search' },
};

const ToolIcon: React.FC<{ type: string }> = ({ type }) => {
  const iconType = TOOL_LABELS[type]?.icon || 'tool';

  switch (iconType) {
    case 'globe':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      );
    case 'file':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      );
    case 'key':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
      );
    case 'search':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
      );
  }
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
          <div key={idx} className={`tool-use-indicator ${tool.isError ? 'error' : ''}`}>
            <span className="tool-use-icon">
              <ToolIcon type={tool.type} />
            </span>
            <span className="tool-use-label">{label}</span>
            {typeof tool.input?.path === 'string' && <span className="tool-use-path">{tool.input.path}</span>}
            {typeof tool.input?.url === 'string' && (
              <span
                className="tool-use-url"
                onClick={(e) => {
                  e.stopPropagation();
                  openUrl(tool.input!.url as string);
                }}
              >
                {tool.input.url.slice(0, 50)}
              </span>
            )}
            {typeof tool.input?.query === 'string' && (
              <span className="tool-use-path">
                {tool.input.query.slice(0, 50)}
                {typeof tool.input?.recency === 'string' && ` (${tool.input.recency})`}
              </span>
            )}
            {isStreaming && <span className="tool-use-spinner" />}
          </div>
        );
      })}
    </div>
  );
};
