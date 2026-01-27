import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ModelInfo } from '../types';
import { ModelSelector } from './ModelSelector';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import './NoteViewer.css';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

// Allow custom URL protocols (wikilink:, provenance:) in addition to standard ones
function urlTransform(url: string): string {
  // Allow our custom protocols
  if (url.startsWith('wikilink:') || url.startsWith('provenance:')) {
    return url;
  }
  // For standard URLs, return as-is (react-markdown handles validation)
  return url;
}

interface ConversationInfo {
  id: string;
  title?: string;
}

interface NoteViewerProps {
  filename: string;
  content: string;
  onSendMessage: (message: string, noteFilename: string, noteContent: string) => void;
  availableModels: ModelInfo[];
  selectedModel: string;
  onModelChange: (modelKey: string) => void;
  favoriteModels?: string[];
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string) => void;
  conversations?: ConversationInfo[]; // For looking up conversation titles
  onGoBack?: () => void; // Navigation history back
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  filename,
  content,
  onSendMessage,
  availableModels,
  selectedModel,
  onModelChange,
  favoriteModels,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
  onGoBack,
}) => {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Focus the input when component mounts
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      // Reset height to calculate scrollHeight accurately
      textareaRef.current.style.height = '44px';
      const scrollHeight = textareaRef.current.scrollHeight;
      // Expand to fit content, capped at max-height (200px)
      const newHeight = Math.min(Math.max(44, scrollHeight), 200);
      textareaRef.current.style.height = newHeight + 'px';
      // Show scrollbar only when content exceeds max-height
      textareaRef.current.style.overflowY = scrollHeight > 200 ? 'auto' : 'hidden';
    }
  }, [input]);

  // Process content to convert [[wiki-links]] to clickable links
  // Process wiki-links in content
  const processedContent = useMemo(() => {
    const result = processWikiLinks(content);
    console.log('[NoteViewer] Content processing:', { original: content, processed: result });
    return result;
  }, [content]);

  // Create markdown components with wiki-link handling
  const markdownComponents = useMemo(() => {
    console.log('[NoteViewer] Creating markdown components with callbacks:', {
      hasOnNavigateToNote: !!onNavigateToNote,
      hasOnNavigateToConversation: !!onNavigateToConversation,
      conversationsCount: conversations?.length
    });
    return createMarkdownComponents({ onNavigateToNote, onNavigateToConversation, conversations });
  }, [onNavigateToNote, onNavigateToConversation, conversations]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      onSendMessage(input.trim(), filename, content);
      setInput('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Format the title from filename (remove .md extension)
  const title = filename.replace(/\.md$/, '');

  return (
    <div className="note-viewer">
      <div className="note-header">
        {onGoBack && (
          <button className="back-button" onClick={onGoBack} title="Go back">
            &larr;
          </button>
        )}
        <h2 className="note-title">{title}</h2>
      </div>

      <div className="note-content-container">
        <div className="note-content">
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={markdownComponents}
            urlTransform={urlTransform}
          >
            {processedContent}
          </ReactMarkdown>
        </div>
      </div>

      <form className="note-input-area" onSubmit={handleSubmit}>
        <div className="note-input-hint">
          Ask a question about this note to start a conversation
        </div>
        <div className="input-row">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this note..."
            rows={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <ModelSelector
            value={selectedModel}
            onChange={onModelChange}
            disabled={false}
            models={availableModels}
            favoriteModels={favoriteModels}
          />
          <button type="submit" disabled={!input.trim()} className="send-button">
            &uarr;
          </button>
        </div>
      </form>
    </div>
  );
};
