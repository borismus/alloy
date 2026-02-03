import React, { useMemo, useRef, useEffect } from 'react';
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
  filename?: string; // Used to detect ramble notes for auto-scroll
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  conversations?: ConversationInfo[]; // For looking up conversation titles
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const prevContentLengthRef = useRef<number>(0);

  // Auto-scroll to bottom for ramble notes when content grows
  const isRambleNote = filename?.startsWith('rambles/');
  useEffect(() => {
    if (isRambleNote && contentRef.current) {
      // Only scroll if content has grown (not on initial load or content changes)
      if (content.length > prevContentLengthRef.current && prevContentLengthRef.current > 0) {
        contentRef.current.scrollTop = contentRef.current.scrollHeight;
      }
      prevContentLengthRef.current = content.length;
    }
  }, [content, isRambleNote]);

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
      <div className="note-content-container" ref={contentRef}>
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
