import React, { useMemo, useRef, useEffect, useState } from 'react';
import { ItemHeader } from './ItemHeader';
import type { ConversationInfo } from '../types';
import { parseFrontmatter, splitFrontmatter } from '../utils/frontmatter';
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
  onContentChange?: (fullContent: string) => void; // Immediate: keep App state in sync
  onSave?: (filename: string, fullContent: string) => void; // Debounced: persist to disk
}

const SAVE_DEBOUNCE_MS = 600;

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  filename,
  onIntegrate,
  onBack,
  canGoBack = false,
  onClose,
  onContentChange,
  onSave,
}) => {
  // Parse frontmatter for the integrate hint; split raw block for editing.
  const { frontmatter } = useMemo(() => parseFrontmatter(content), [content]);
  const { rawFrontmatter, body } = useMemo(() => splitFrontmatter(content), [content]);
  const isRiffNote = filename?.startsWith('riffs/');
  const isUnintegrated = isRiffNote && frontmatter.integrated === false;

  // Local editing state holds the BODY only; frontmatter is re-attached on save.
  const [draft, setDraft] = useState(body);
  const draftRef = useRef(body); // mirrors draft for the unmount flush
  const lastEmittedBodyRef = useRef(body); // tracks our own edits to avoid clobbering
  const saveTimer = useRef<number | undefined>(undefined);

  // Reset local draft only on a genuine external change (e.g. file edited
  // elsewhere). Our own edits set lastEmittedBodyRef, so they don't trigger a
  // reset and the caret stays put.
  useEffect(() => {
    if (body !== lastEmittedBodyRef.current) {
      setDraft(body);
      draftRef.current = body;
      lastEmittedBodyRef.current = body;
    }
  }, [body]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newBody = e.target.value;
    const full = rawFrontmatter + newBody;
    setDraft(newBody);
    draftRef.current = newBody;
    lastEmittedBodyRef.current = newBody;
    onContentChange?.(full);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (filename) onSave?.(filename, full);
    }, SAVE_DEBOUNCE_MS);
  };

  // Flush any pending save on unmount / note switch so the last edit isn't lost.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (filename) onSave?.(filename, rawFrontmatter + draftRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className="note-content-container">
        <textarea
          className="note-editor"
          value={draft}
          onChange={handleChange}
          spellCheck={false}
          placeholder="Empty note"
        />
      </div>
    </div>
  );
};
