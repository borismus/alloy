import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { NoteInfo } from '../types';
import { rambleService } from '../services/ramble';
import { useRambleContext } from '../contexts/RambleContext';
import { MarkdownContent } from './MarkdownContent';
import { AppendOnlyTextarea } from './AppendOnlyTextarea';
import { ItemHeader } from './ItemHeader';
import './RambleView.css';

interface ConversationInfo {
  id: string;
  title?: string;
}

interface RambleViewProps {
  notes: NoteInfo[];
  model: string;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  conversations?: ConversationInfo[];
  onExit?: () => void;
}

// Allow custom URL protocols (wikilink:, provenance:) in addition to standard ones
function urlTransform(url: string): string {
  if (url.startsWith('wikilink:') || url.startsWith('provenance:')) {
    return url;
  }
  return url;
}

// Parse frontmatter from content
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const frontmatterStr = match[1];
  const body = match[2];

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

export const RambleView: React.FC<RambleViewProps> = ({
  notes,
  model,
  onNavigateToNote,
  onNavigateToConversation,
  conversations,
  onExit,
}) => {
  const {
    rawLog,
    crystallizedOffset,
    draftFilename,
    isRambleMode,
    isCrystallizing,
    isProcessing,
    setRawLog,
    exitRambleMode,
    integrateNow,
    setConfig,
  } = useRambleContext();

  const [draftContent, setDraftContent] = useState('');
  const draftContentRef = useRef<HTMLDivElement>(null);

  // Keep config updated
  useEffect(() => {
    setConfig(model, notes);
  }, [model, notes, setConfig]);

  // Load draft content when draftFilename changes
  useEffect(() => {
    if (!draftFilename) {
      setDraftContent('');
      return;
    }

    const loadDraft = async () => {
      const vaultPath = rambleService.getVaultPath();
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
        console.error('[RambleView] Failed to load draft:', error);
      }
    };

    loadDraft();
    // Poll for updates while crystallizing or processing
    const interval = setInterval(loadDraft, 1000);
    return () => clearInterval(interval);
  }, [draftFilename, isCrystallizing, isProcessing]);

  // Auto-scroll draft content when it updates
  useEffect(() => {
    if (draftContentRef.current && draftContent) {
      draftContentRef.current.scrollTop = draftContentRef.current.scrollHeight;
    }
  }, [draftContent]);

  // Handle input changes - pass full value to context
  const handleInputChange = useCallback((newValue: string) => {
    setRawLog(newValue);
  }, [setRawLog]);

  // Handle integrate
  const handleIntegrate = useCallback(() => {
    integrateNow();
  }, [integrateNow]);

  // Handle exit
  const handleExit = useCallback(() => {
    exitRambleMode();
    onExit?.();
  }, [exitRambleMode, onExit]);

  // Parse draft frontmatter
  const { body: draftBody } = useMemo(() => parseFrontmatter(draftContent), [draftContent]);

  // Format the draft filename for display (e.g., "2026-02-08-182702" -> "2026-02-08 at 18:27")
  const headerTitle = useMemo(() => {
    if (!draftFilename) return 'Ramble';
    const basename = draftFilename.split('/').pop()?.replace('.md', '') || '';
    const match = basename.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (match) {
      const [, year, month, day, hour, minute] = match;
      return `${year}-${month}-${day} at ${hour}:${minute}`;
    }
    return basename;
  }, [draftFilename]);

  if (!isRambleMode) {
    return null;
  }

  return (
    <div className="ramble-view">
      <ItemHeader title={headerTitle} onBack={handleExit}>
        {draftFilename && (
          <>
            <span className="draft-indicator">
              {isProcessing ? 'Integrating...' : isCrystallizing ? 'Crystallizing...' : 'Draft'}
            </span>
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

      {/* Draft content area - only shown when there's an active draft */}
      {draftFilename && draftBody && (
        <div className="ramble-draft-section">
          <div className="ramble-draft-header">
            <h3>Draft</h3>
          </div>
          <div className="ramble-draft-content" ref={draftContentRef}>
            <MarkdownContent
              content={draftBody}
              className="note-content"
              onNavigateToNote={onNavigateToNote}
              onNavigateToConversation={onNavigateToConversation}
              conversations={conversations}
              urlTransform={urlTransform}
            />
          </div>
        </div>
      )}

      {/* Ramble log input - always visible */}
      <div className="ramble-log-section">
        <div className="ramble-log-header">
          <h3>Log</h3>
          <span className="ramble-log-hint">
            {draftFilename
              ? 'Type to update the draft...'
              : 'Start typing to create a draft...'}
          </span>
        </div>
        <div className="ramble-log-input">
          <AppendOnlyTextarea
            value={rawLog}
            onChange={handleInputChange}
            lockedLength={crystallizedOffset}
            placeholder="What's on your mind? Start typing..."
            disabled={isProcessing}
          />
        </div>
      </div>
    </div>
  );
};
