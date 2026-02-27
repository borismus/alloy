import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import * as yaml from 'js-yaml';
import { NoteInfo, RiffArtifactType, RiffComment } from '../types';
import { riffService } from '../services/riff';
import { useRiffContext } from '../contexts/RiffContext';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useDictation } from '../hooks/useDictation';
import { MarkdownContent } from './MarkdownContent';
import { MermaidDiagram } from './MermaidDiagram';
import { ItemHeader } from './ItemHeader';
import './RiffView.css';

interface ConversationInfo {
  id: string;
  title?: string;
}

interface RiffViewProps {
  notes: NoteInfo[];
  model: string;
  sonioxApiKey?: string;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  conversations?: ConversationInfo[];
  onBack?: () => void;
  canGoBack?: boolean;
  onClose?: () => void;
}

// Allow custom URL protocols (wikilink:, provenance:) in addition to standard ones
function urlTransform(url: string): string {
  if (url.startsWith('wikilink:') || url.startsWith('provenance:')) {
    return url;
  }
  return url;
}

interface HistoryEntry {
  timestamp: string;
  change: string;
}

// Parse frontmatter from content using js-yaml
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  try {
    const frontmatter = (yaml.load(match[1]) as Record<string, any>) || {};
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: {}, body: match[2] };
  }
}

// Format timestamp as relative time ("2m ago", "1h ago", "yesterday")
function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  return `${diffDay}d ago`;
}

// Split document body into paragraphs (blocks separated by double newlines)
function splitIntoParagraphs(body: string): string[] {
  return body.split(/\n\n+/).filter(p => p.trim());
}

// Find which paragraph index a comment anchors to (by index, with snippet fallback)
function resolveCommentAnchor(comment: RiffComment, paragraphs: string[]): number {
  // Try exact index first
  if (comment.anchor.paragraphIndex < paragraphs.length) {
    return comment.anchor.paragraphIndex;
  }
  // Fallback: fuzzy match by snippet
  if (comment.anchor.snippet) {
    const idx = paragraphs.findIndex(p => p.includes(comment.anchor.snippet));
    if (idx !== -1) return idx;
  }
  return -1;
}

export const RiffView: React.FC<RiffViewProps> = ({
  notes,
  model,
  sonioxApiKey,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
  onBack,
  canGoBack = false,
  onClose,
}) => {
  const {
    inputText,
    draftFilename,
    isRiffMode,
    isUpdating,
    isProcessing,
    isCommenting,
    artifactType,
    comments,
    setInputText,
    sendMessage,
    exitRiffMode,
    setArtifactType,
    resolveComment,
    integrateNow,
    setConfig,
  } = useRiffContext();

  const [draftContent, setDraftContent] = useState('');
  const [activeCommentParagraph, setActiveCommentParagraph] = useState<number | null>(null);
  const [collapsedParagraphs, setCollapsedParagraphs] = useState<Set<number>>(new Set());
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const documentPaneRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preExistingTextRef = useRef('');
  const commentElsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  // Dictation
  const handleTranscript = useCallback((text: string) => {
    const pre = preExistingTextRef.current;
    setInputText(pre ? pre + ' ' + text : text);
  }, [setInputText]);

  const handleEndpoint = useCallback((finalText: string) => {
    // Pass text directly to sendMessage to avoid React state race condition
    const pre = preExistingTextRef.current;
    const fullText = pre ? pre + ' ' + finalText : finalText;
    sendMessage(fullText);
    preExistingTextRef.current = '';
  }, [sendMessage]);

  const { dictationState, error: dictationError, toggleDictation, cancelDictation } = useDictation({
    apiKey: sonioxApiKey,
    onTranscript: handleTranscript,
    onEndpoint: handleEndpoint,
  });

  const isRecording = dictationState === 'recording';
  const isDictationBusy = dictationState === 'starting' || dictationState === 'stopping';

  // Keep config updated
  useEffect(() => {
    setConfig(model, notes);
  }, [model, notes, setConfig]);

  // Focus textarea when entering riff mode or switching drafts
  useLayoutEffect(() => {
    if (isRiffMode) {
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
    }
  }, [isRiffMode, draftFilename]);

  // Load draft content when draftFilename changes
  useEffect(() => {
    if (!draftFilename) {
      setDraftContent('');
      return;
    }

    const loadDraft = async () => {
      const vaultPath = riffService.getVaultPath();
      if (!vaultPath) return;

      try {
        const { join } = await import('@tauri-apps/api/path');
        const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
        const fullPath = await join(vaultPath, draftFilename);
        if (await exists(fullPath)) {
          const content = await readTextFile(fullPath);
          setDraftContent(content);
        }
      } catch (error) {
        console.error('[RiffView] Failed to load draft:', error);
      }
    };

    loadDraft();
    // Poll for updates while updating or processing
    const interval = setInterval(loadDraft, 1000);
    return () => clearInterval(interval);
  }, [draftFilename, isUpdating, isProcessing]);

  // Auto-scroll document pane to bottom when content updates (for note type)
  useEffect(() => {
    if (documentPaneRef.current && draftContent && artifactType === 'note') {
      documentPaneRef.current.scrollTop = documentPaneRef.current.scrollHeight;
    }
  }, [draftContent, artifactType]);

  // Handle artifact type change
  const handleArtifactTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setArtifactType(e.target.value as RiffArtifactType);
  }, [setArtifactType]);

  // Handle integrate
  const handleIntegrate = useCallback(() => {
    integrateNow();
  }, [integrateNow]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    exitRiffMode();
    onBack?.();
  }, [exitRiffMode, onBack]);

  // Handle send
  const handleSend = useCallback(() => {
    if (dictationState !== 'idle') {
      cancelDictation();
    }
    sendMessage();
  }, [sendMessage, dictationState, cancelDictation]);

  // Handle dictation toggle
  const handleToggleDictation = useCallback(() => {
    if (dictationState === 'idle') {
      preExistingTextRef.current = inputText;
    }
    toggleDictation();
  }, [dictationState, inputText, toggleDictation]);

  // Keyboard handler for Enter-to-send
  const handleKeyDown = useChatKeyboard({
    onSubmit: handleSend,
    isStreaming: isUpdating,
  });

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }, [setInputText]);

  // Parse draft frontmatter
  const { draftBody, history } = useMemo(() => {
    const { frontmatter, body } = parseFrontmatter(draftContent);
    const h: HistoryEntry[] = Array.isArray(frontmatter.history) ? frontmatter.history : [];
    return { draftBody: body, history: h };
  }, [draftContent]);

  // Split body into paragraphs for note type
  const paragraphs = useMemo(() => {
    if (artifactType !== 'note' || !draftBody) return [];
    return splitIntoParagraphs(draftBody);
  }, [artifactType, draftBody]);

  // Build a set of paragraph indices that have comments
  const commentsByParagraph = useMemo(() => {
    const map = new Map<number, RiffComment[]>();
    for (const comment of comments) {
      const idx = resolveCommentAnchor(comment, paragraphs);
      if (idx === -1) continue;
      const existing = map.get(idx) || [];
      existing.push(comment);
      map.set(idx, existing);
    }
    return map;
  }, [comments, paragraphs]);

  // Detect overlapping comment bubbles and collapse them
  useLayoutEffect(() => {
    const entries: { index: number; el: HTMLDivElement }[] = [];
    for (const [index, el] of commentElsRef.current.entries()) {
      entries.push({ index, el });
    }
    if (entries.length < 2) {
      setCollapsedParagraphs(prev => prev.size === 0 ? prev : new Set());
      return;
    }
    entries.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);

    const COLLAPSED_HEIGHT = 40;
    const newCollapsed = new Set<number>();
    let occupiedBottom = -Infinity;

    for (const { index, el } of entries) {
      const rect = el.getBoundingClientRect();
      const isActive = activeCommentParagraph === index;

      if (!isActive && rect.top < occupiedBottom) {
        newCollapsed.add(index);
        occupiedBottom = Math.max(occupiedBottom, rect.top + COLLAPSED_HEIGHT);
      } else {
        occupiedBottom = rect.bottom;
      }
    }

    setCollapsedParagraphs(prev => {
      if (prev.size === newCollapsed.size && [...newCollapsed].every(i => prev.has(i))) return prev;
      return newCollapsed;
    });
  }, [comments, paragraphs, activeCommentParagraph]);

  // Extract mermaid code from draft body
  const mermaidCode = useMemo(() => {
    if (artifactType !== 'mermaid' || !draftBody) return null;
    const match = draftBody.match(/```mermaid\n([\s\S]*?)```/);
    return match ? match[1].trim() : null;
  }, [artifactType, draftBody]);

  // Title is the filename without path and extension
  const headerTitle = useMemo(() => {
    if (!draftFilename) return 'Riff';
    return draftFilename.split('/').pop()?.replace('.md', '') || 'Riff';
  }, [draftFilename]);

  const isNoteType = artifactType === 'note';

  if (!isRiffMode) {
    return null;
  }

  return (
    <div className="riff-view">
      <ItemHeader
        title={headerTitle}
        onBack={handleBack}
        canGoBack={canGoBack}
        onClose={onClose}
      >
        {draftFilename && (
          <>
            <select
              className="artifact-type-select"
              value={artifactType}
              onChange={handleArtifactTypeChange}
              disabled={isProcessing || isUpdating}
              title="Artifact type"
            >
              <option value="note">Transcript</option>
              <option value="mermaid">Mermaid Diagram</option>
              <option value="table">Table</option>
              <option value="summary">Summary</option>
            </select>
            {(isProcessing || isUpdating) && (
              <span className="draft-indicator">
                {isProcessing ? 'Integrating...' : 'Updating...'}
              </span>
            )}
            <button
              className="btn-small btn-accent"
              onClick={handleIntegrate}
              disabled={isProcessing}
              title="Integrate draft into notes"
            >
              Integrate
            </button>
          </>
        )}
      </ItemHeader>

      {/* Content area */}
      {draftFilename && draftBody ? (
        <div className="riff-content-area">
          <div
            className={`riff-document-pane ${mermaidCode ? 'riff-draft-canvas' : ''} ${artifactType === 'table' ? 'riff-draft-table' : ''} ${isNoteType && comments.length > 0 ? 'riff-transcript' : ''}`}
            ref={documentPaneRef}
          >
            {mermaidCode ? (
              <MermaidDiagram code={mermaidCode} />
            ) : isNoteType ? (
              <div className="riff-paragraphs">
                {paragraphs.map((paragraph, index) => {
                  const paragraphComments = commentsByParagraph.get(index);
                  const hasComment = !!paragraphComments;
                  const isActive = activeCommentParagraph === index;
                  const isCollapsed = collapsedParagraphs.has(index);
                  return (
                    <div
                      key={index}
                      className={`riff-paragraph ${hasComment ? 'has-comment' : ''} ${isActive ? 'active-comment' : ''}`}
                      data-paragraph-index={index}
                      onClick={hasComment ? () => setActiveCommentParagraph(isActive ? null : index) : undefined}
                    >
                      <MarkdownContent
                        content={paragraph}
                        className="note-content"
                        onNavigateToNote={onNavigateToNote}
                        onNavigateToConversation={onNavigateToConversation}
                        conversations={conversations}
                        urlTransform={urlTransform}
                      />
                      {paragraphComments && (
                        <div
                          className={`riff-margin-comments ${isActive ? 'active' : ''} ${isCollapsed ? 'collapsed' : ''}`}
                          ref={el => { if (el) commentElsRef.current.set(index, el); else commentElsRef.current.delete(index); }}
                        >
                          {paragraphComments.map(comment => (
                            <div key={comment.id} className="riff-comment-card">
                              <MarkdownContent
                                content={comment.content}
                                className="riff-comment-content"
                                onNavigateToNote={onNavigateToNote}
                                onNavigateToConversation={onNavigateToConversation}
                                conversations={conversations}
                                urlTransform={urlTransform}
                              />
                              <button
                                className="riff-comment-dismiss"
                                onClick={(e) => { e.stopPropagation(); resolveComment(comment.id); }}
                                title="Dismiss comment"
                              >
                                &times;
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <MarkdownContent
                content={draftBody}
                className="note-content"
                onNavigateToNote={onNavigateToNote}
                onNavigateToConversation={onNavigateToConversation}
                conversations={conversations}
                urlTransform={urlTransform}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="riff-content-area" />
      )}

      {(isCommenting || isUpdating) && (
        <div className="riff-activity-indicator" title={isUpdating ? 'Updating...' : 'Generating comments...'}>
          <span className="riff-activity-spinner" />
        </div>
      )}

      {/* History section - collapsible, for mermaid/table only */}
      {!isNoteType && history.length > 0 && (
        <div className="riff-history-section">
          <button
            className="riff-history-toggle"
            onClick={() => setHistoryExpanded(v => !v)}
          >
            {historyExpanded ? '\u25BE' : '\u25B8'} History ({history.length})
          </button>
          {historyExpanded && (
            <div className="riff-history-list">
              {history.slice().reverse().map((entry, i) => (
                <div key={i} className="riff-history-entry">
                  <span className="riff-history-time">{relativeTime(entry.timestamp)}</span>
                  <span className="riff-history-change">{entry.change}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Input area - always visible */}
      <div className="riff-input-area">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={isRecording ? 'Listening...' : draftFilename ? 'Type to add to the document...' : 'Start typing to create a draft...'}
          disabled={isProcessing || isRecording}
          rows={1}
        />
        {sonioxApiKey && (
          <button
            className={`riff-mic-button ${isRecording ? 'recording' : ''}`}
            onClick={handleToggleDictation}
            disabled={isProcessing || isDictationBusy}
            title={isRecording ? 'Stop dictation' : 'Start dictation'}
          >
            {isRecording ? '\u25A0' : '\u{1F3A4}'}
          </button>
        )}
        <button
          className="riff-send-button"
          onClick={handleSend}
          disabled={!inputText.trim() || isProcessing}
          title="Send (Enter)"
        >
          {isUpdating ? '...' : '\u2191'}
        </button>
      </div>
      {dictationError && (
        <div className="riff-dictation-error">{dictationError}</div>
      )}
    </div>
  );
};
