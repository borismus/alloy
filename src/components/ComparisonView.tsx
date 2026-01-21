import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ModelInfo, ComparisonResponse, ProviderType } from '../types';
import './ComparisonView.css';

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

interface ComparisonViewProps {
  models: ModelInfo[];
  streamingContents: Map<string, string>;
  statuses: Map<string, ComparisonResponse['status']>;
  errors: Map<string, string>;
  onStopAll: () => void;
}

const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

const getModelKey = (model: ModelInfo) => `${model.provider}:${model.id}`;

export function ComparisonView({
  models,
  streamingContents,
  statuses,
  errors,
  onStopAll,
}: ComparisonViewProps) {
  const modelCount = models.length;

  return (
    <div
      className="comparison-view"
      style={{ '--model-count': modelCount } as React.CSSProperties}
    >
      <div className="comparison-columns">
        {models.map((model) => {
          const modelKey = getModelKey(model);
          const status = statuses.get(modelKey) || 'pending';
          const content = streamingContents.get(modelKey) || '';
          const error = errors.get(modelKey);

          return (
            <div key={modelKey} className={`comparison-column status-${status}`}>
              <div className="column-header">
                <div className="model-info">
                  <span className="model-name">{model.name}</span>
                  <span className={`provider-badge provider-${model.provider}`}>
                    {PROVIDER_NAMES[model.provider]}
                  </span>
                </div>
              </div>

              <div className="column-content">
                {status === 'pending' && (
                  <div className="pending-indicator">
                    <span>Waiting...</span>
                  </div>
                )}

                {status === 'streaming' && !content && (
                  <div className="thinking-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                )}

                {content && (
                  <div className="response-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={markdownComponents}
                    >
                      {content}
                    </ReactMarkdown>
                  </div>
                )}

                {status === 'error' && (
                  <div className="error-content">
                    <div className="error-icon">!</div>
                    <div className="error-message">{error || 'An error occurred'}</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="comparison-controls">
        <button className="stop-all-button" onClick={onStopAll}>
          Stop All
        </button>
      </div>
    </div>
  );
}
