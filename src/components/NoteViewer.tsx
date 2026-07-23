import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { ItemHeader } from './ItemHeader';
import { MarkdownContent } from './MarkdownContent';
import { AiEditPanel } from './AiEditPanel';
import type { ConversationInfo, ModelInfo } from '../types';
import { parseFrontmatter } from '../utils/frontmatter';
import './NoteViewer.css';

// One-shot rewrite prompt: the model gets the current note body and returns the
// full revised body. Passing the current content is essential — without it the
// model has nothing to preserve and rewrites from scratch.
function noteEditPrompt(currentBody: string): string {
  return `You are editing the user's markdown note based on their instruction.

CURRENT NOTE:
${currentBody.trim() || '(empty)'}

RULES:
- Return the COMPLETE updated note body as markdown — the full document, not just the changed part.
- Preserve everything the instruction doesn't ask you to change (headings, structure, wording, wikilinks).
- Do NOT include YAML frontmatter (the --- block); return body content only.
- Output ONLY the note content — no code fences, no commentary, no explanation.
- Use [[Note Name]] double-bracket syntax for any note links.`;
}

interface NoteViewerProps {
  content: string;
  filename?: string; // Used to detect riff notes for auto-scroll
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  onIntegrate?: () => void; // Called when user wants to integrate a riff
  onEdit?: (filename: string) => void; // Open the note in the external editor
  conversations?: ConversationInfo[]; // For looking up conversation titles
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
  // AI edit composer (optional — only rendered when a model + save handler exist)
  onSaveNote?: (filename: string, content: string) => Promise<void>;
  availableModels?: ModelInfo[];
  favoriteModels?: string[];
  onToggleFavorite?: (modelKey: string) => void;
  defaultModel?: string;
}

export const NoteViewer: React.FC<NoteViewerProps> = ({
  content,
  filename,
  onNavigateToNote,
  onNavigateToConversation,
  onIntegrate,
  onEdit,
  conversations,
  onBack,
  canGoBack = false,
  onClose,
  onSaveNote,
  availableModels,
  favoriteModels,
  onToggleFavorite,
  defaultModel,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const prevContentLengthRef = useRef<number>(0);

  // Parse frontmatter and get body content
  const { frontmatter, body } = useMemo(() => parseFrontmatter(content), [content]);
  const isRiffNote = filename?.startsWith('riffs/');
  const isUnintegrated = isRiffNote && frontmatter.integrated === false;

  // AI edit: diff/rewrite the body, preserving any raw frontmatter block.
  const rawFrontmatter = useMemo(() => content.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '', [content]);
  const getCurrentContent = useCallback(() => body, [body]);
  const applyNoteEdit = useCallback(async (newBody: string) => {
    if (!filename || !onSaveNote) return;
    await onSaveNote(filename, rawFrontmatter + newBody.replace(/\n*$/, '') + '\n');
  }, [filename, onSaveNote, rawFrontmatter]);
  const canAiEdit = !!(filename && onSaveNote && defaultModel && availableModels && availableModels.length > 0);

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
      >
        {filename && onEdit && (
          <button
            className="edit-note-btn"
            onClick={() => onEdit(filename)}
            title="Open this note in your external editor"
          >
            Edit
          </button>
        )}
      </ItemHeader>
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
      {canAiEdit && (
        <AiEditPanel
          placeholder="Edit this note"
          getCurrentContent={getCurrentContent}
          buildSystemPrompt={noteEditPrompt}
          applyNewContent={applyNoteEdit}
          defaultModel={defaultModel!}
          availableModels={availableModels!}
          favoriteModels={favoriteModels}
          onToggleFavorite={onToggleFavorite}
        />
      )}
    </div>
  );
};
