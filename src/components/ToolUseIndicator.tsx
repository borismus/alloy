import React, { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ToolUse, getModelIdFromModel } from '../types';
import './ToolUseIndicator.css';

interface ToolUseIndicatorProps {
  toolUse: ToolUse[];
  isStreaming?: boolean;
  onNavigateToNote?: (noteFilename: string) => void;
}

const TOOL_LABELS: Record<string, { active: string; complete: string; icon?: string }> = {
  read_file: { active: 'Reading', complete: 'Read file', icon: 'file' },
  write_file: { active: 'Writing', complete: 'Wrote file', icon: 'file' },
  append_file: { active: 'Appending', complete: 'Appended to file', icon: 'file' },
  append_to_note: { active: 'Appending', complete: 'Append', icon: 'file' },
  http_get: { active: 'Fetching URL', complete: 'Fetched URL', icon: 'globe' },
  http_post: { active: 'Sending request', complete: 'Sent request', icon: 'globe' },
  get_secret: { active: 'Getting secret', complete: 'Got secret', icon: 'key' },
  web_search: { active: 'Searching', complete: 'Searched', icon: 'search' },
  spawn_subagent: { active: 'Running sub-agents', complete: 'Ran sub-agents', icon: 'agents' },
};

interface ParsedAgentConfig {
  name: string;
  prompt: string;
  model?: string;
}

function parseSubagentInput(tool: ToolUse): ParsedAgentConfig[] {
  try {
    const raw = tool.input?.agents as string;
    if (!raw) return [];
    const configs = JSON.parse(raw);
    if (!Array.isArray(configs)) return [];
    return configs.map((c: any) => ({
      name: c.name || 'Agent',
      prompt: c.prompt || '',
      model: c.model,
    }));
  } catch {
    return [];
  }
}

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
    case 'agents':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
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
  isStreaming = false,
  onNavigateToNote,
}) => {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (toolUse.length === 0) return null;

  return (
    <div className="tool-use-indicators">
      {toolUse.map((tool, idx) => {
        const labels = TOOL_LABELS[tool.type] || { active: tool.type, complete: tool.type };
        const isToolComplete = !!tool.result || !isStreaming;

        // Special rendering for spawn_subagent
        if (tool.type === 'spawn_subagent') {
          const agents = parseSubagentInput(tool);
          const agentNames = agents.map(a => a.name).join(', ');
          const label = isToolComplete
            ? `Ran sub-agents${agentNames ? ': ' + agentNames : ''}`
            : `Running sub-agents${agentNames ? ': ' + agentNames : ''}`;
          const isExpanded = expandedIdx === idx;

          return (
            <div key={idx} className="tool-use-subagent-wrapper">
              <div
                className={`tool-use-indicator clickable ${tool.isError ? 'error' : ''}`}
                title={tool.isError && tool.result ? tool.result : undefined}
                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              >
                <span className="tool-use-icon">
                  <ToolIcon type={tool.type} />
                </span>
                <span className="tool-use-label">{label}</span>
                {isStreaming && !tool.result && <span className="tool-use-spinner" />}
              </div>
              {isExpanded && agents.length > 0 && (
                <div className="tool-use-subagent-details">
                  {agents.map((agent, i) => (
                    <div key={i} className="tool-use-subagent-detail">
                      <div className="tool-use-subagent-detail-name">{agent.name}</div>
                      {agent.model && (
                        <div className="tool-use-subagent-detail-model">
                          {getModelIdFromModel(agent.model)}
                        </div>
                      )}
                      <div className="tool-use-subagent-detail-prompt">{agent.prompt}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }

        // For web_search, include the query in the label
        let label = isToolComplete ? labels.complete : labels.active;
        if (tool.type === 'web_search' && typeof tool.input?.query === 'string') {
          const query = tool.input.query.length > 40
            ? tool.input.query.slice(0, 40) + '...'
            : tool.input.query;
          label = isToolComplete ? `Searched "${query}"` : `Searching "${query}"`;
        }

        return (
          <div
            key={idx}
            className={`tool-use-indicator ${tool.isError ? 'error' : ''}`}
            title={tool.isError && tool.result ? tool.result : undefined}
          >
            <span className="tool-use-icon">
              <ToolIcon type={tool.type} />
            </span>
            <span className="tool-use-label">{label}</span>
            {typeof tool.input?.path === 'string' && (() => {
              const path = tool.input.path as string;
              // Make notes/ files and memory.md clickable for navigation
              const isNavigable = onNavigateToNote && (
                (path.startsWith('notes/') && path.endsWith('.md')) ||
                path === 'memory.md'
              );

              if (isNavigable) {
                return (
                  <span
                    className="tool-use-path clickable"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Strip notes/ prefix - handleSelectNote adds it back
                      const filename = path.replace(/^notes\//, '');
                      onNavigateToNote(filename);
                    }}
                  >
                    {path}
                  </span>
                );
              }
              return <span className="tool-use-path">{path}</span>;
            })()}
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
            {tool.type !== 'web_search' && typeof tool.input?.query === 'string' && (
              <span className="tool-use-path">
                {tool.input.query.slice(0, 50)}
              </span>
            )}
            {tool.type === 'web_search' && typeof tool.input?.recency === 'string' && (
              <span className="tool-use-path">({tool.input.recency})</span>
            )}
            {isStreaming && !tool.result && <span className="tool-use-spinner" />}
          </div>
        );
      })}
    </div>
  );
};
