import React, { useMemo, useRef, useEffect } from 'react';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import './NoteViewer.css';

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
  // Navigation
  canGoBack?: boolean;
  onGoBack?: () => void;
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  onIntegrate,
  conversations,
  canGoBack,
  onGoBack,
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

  // Get display name from filename
  const displayName = filename
    ? filename.replace(/^(notes\/|rambles\/)/, '').replace(/\.md$/, '')
    : 'Note';

  return (
    <div className="note-viewer">
      <ItemHeader
        title={displayName}
        onBack={onGoBack}
        canGoBack={canGoBack}
      />
      {isUnintegrated && onIntegrate && (
        <div className="ramble-integrate-bar">
          <span className="integrate-hint">This ramble hasn't been integrated yet</span>
          <button className="integrate-btn" onClick={onIntegrate}>
            Integrate
          </button>
        </div>
      )}
      <div className="note-content-container" ref={contentRef}>
        <MarkdownContent
          content={body}
          className="note-content"
          onNavigateToNote={onNavigateToNote}
          onNavigateToConversation={onNavigateToConversation}
          conversations={conversations}
          urlTransform={urlTransform}
        />
      </div>
    </div>
  );
};
