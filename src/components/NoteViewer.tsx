import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import './NoteViewer.css';
import './MarkdownContent.css';
import 'highlight.js/styles/github-dark.css';

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
  content: string;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string) => void;
  conversations?: ConversationInfo[]; // For looking up conversation titles
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
}) => {
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

  return (
    <div className="note-viewer">
      <div className="note-content-container">
        <div className="note-content markdown-content">
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
    </div>
  );
};
