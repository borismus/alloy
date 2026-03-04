import React, { useMemo, useRef, useEffect } from 'react';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import type { ConversationInfo } from '../types';
import { parseFrontmatter } from '../utils/frontmatter';
import './NoteViewer.css';

interface NoteViewerProps {
  content: string;
  filename?: string; // Used to detect riff notes for auto-scroll
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  onIntegrate?: () => void; // Called when user wants to integrate a riff
  conversations?: ConversationInfo[]; // For looking up conversation titles
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  onIntegrate,
  conversations,
  onBack,
  canGoBack = false,
  onClose,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const prevContentLengthRef = useRef<number>(0);

  // Parse frontmatter and get body content
  const { frontmatter, body } = useMemo(() => parseFrontmatter(content), [content]);
  const isRiffNote = filename?.startsWith('riffs/');
  const isUnintegrated = isRiffNote && frontmatter.integrated === false;

  // Auto-scroll to bottom for riff notes when content grows
  useEffect(() => {
    if (isRiffNote && contentRef.current) {
      // Only scroll if content has grown (not on initial load or content changes)
      if (body.length > prevContentLengthRef.current && prevContentLengthRef.current > 0) {
        contentRef.current.scrollTop = contentRef.current.scrollHeight;
      }
      prevContentLengthRef.current = body.length;
    }
  }, [body, isRiffNote]);

  // Get display name from filename
  const displayName = filename
    ? filename.replace(/^(notes\/|riffs\/)/, '').replace(/\.md$/, '')
    : 'Note';

  return (
    <div className="note-viewer">
      <ItemHeader
        title={displayName}
        onBack={onBack}
        canGoBack={canGoBack}
        onClose={onClose}
      />
      {isUnintegrated && onIntegrate && (
        <div className="riff-integrate-bar">
          <span className="integrate-hint">This riff hasn't been integrated yet</span>
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
        />
      </div>
    </div>
  );
};
