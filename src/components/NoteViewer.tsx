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

// Parse YAML frontmatter from content
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const frontmatterStr = match[1];
  const body = match[2];

  // Simple YAML parsing for key: value pairs
  const frontmatter: Record<string, any> = {};
  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value === 'true' ? true : value === 'false' ? false : value;
    }
  }

  return { frontmatter, body };
}

interface NoteViewerProps {
  content: string;
  filename?: string; // Used to detect ramble notes for auto-scroll
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  onIntegrate?: () => void; // Called when user wants to integrate a ramble
  conversations?: ConversationInfo[]; // For looking up conversation titles
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  onIntegrate,
  conversations,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const prevContentLengthRef = useRef<number>(0);

  // Parse frontmatter and get body content
  const { frontmatter, body } = useMemo(() => parseFrontmatter(content), [content]);
  const isRambleNote = filename?.startsWith('rambles/');
  const isUnintegrated = isRambleNote && frontmatter.integrated === false;

  // Auto-scroll to bottom for ramble notes when content grows
  useEffect(() => {
    if (isRambleNote && contentRef.current) {
      // Only scroll if content has grown (not on initial load or content changes)
      if (body.length > prevContentLengthRef.current && prevContentLengthRef.current > 0) {
        contentRef.current.scrollTop = contentRef.current.scrollHeight;
      }
      prevContentLengthRef.current = body.length;
    }
  }, [body, isRambleNote]);

  // Process wiki-links in content (use body without frontmatter)
  const processedContent = useMemo(() => {
    const result = processWikiLinks(body);
    console.log('[NoteViewer] Content processing:', { original: body, processed: result });
    return result;
  }, [body]);

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
      {isUnintegrated && onIntegrate && (
        <div className="ramble-integrate-bar">
          <span className="integrate-hint">This ramble hasn't been integrated yet</span>
          <button className="integrate-btn" onClick={onIntegrate}>
            Integrate
          </button>
        </div>
      )}
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
