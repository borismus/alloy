import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { NoteInfo } from '../types';
import { rambleService } from '../services/ramble';
import { useRambleContext } from '../contexts/RambleContext';
import { MarkdownContent } from './MarkdownContent';
import { AppendOnlyTextarea, AppendOnlyTextareaHandle } from './AppendOnlyTextarea';
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
  onBack?: () => void;
  canGoBack?: boolean;
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
  onBack,
  canGoBack = false,
}) => {
  const {
    rawLog,
    crystallizedOffset,
    draftFilename,
    isRambleMode,
    isCrystallizing,
    isProcessing,
    crystallizationCount,
    setRawLog,
    exitRambleMode,
    integrateNow,
    setConfig,
  } = useRambleContext();

  const [draftContent, setDraftContent] = useState('');
  const [justCrystallized, setJustCrystallized] = useState(false);
  const draftContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<AppendOnlyTextareaHandle>(null);
  const prevCrystallizationCountRef = useRef<number>(0);

  // Keep config updated
  useEffect(() => {
    setConfig(model, notes);
  }, [model, notes, setConfig]);

  // Focus and scroll to bottom when entering ramble mode or switching drafts
  useLayoutEffect(() => {
    if (isRambleMode) {
      // Small delay to ensure the textarea is rendered
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.scrollToBottom();
      }, 0);
    }
  }, [isRambleMode, draftFilename]);

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

  // Detect crystallization completion and trigger highlight + scroll
  useEffect(() => {
    if (crystallizationCount > prevCrystallizationCountRef.current) {
      // Crystallization just completed - show highlight animation
      setJustCrystallized(true);

      // Smooth scroll to bottom to show new content
      if (draftContentRef.current) {
        draftContentRef.current.scrollTo({
          top: draftContentRef.current.scrollHeight,
          behavior: 'smooth'
        });
      }

      // Clear highlight after animation completes
      const timer = setTimeout(() => {
        setJustCrystallized(false);
      }, 3000);

      prevCrystallizationCountRef.current = crystallizationCount;
      return () => clearTimeout(timer);
    }

    prevCrystallizationCountRef.current = crystallizationCount;
  }, [crystallizationCount]);

  // Handle input changes - pass full value to context
  const handleInputChange = useCallback((newValue: string) => {
    setRawLog(newValue);
  }, [setRawLog]);

  // Handle integrate
  const handleIntegrate = useCallback(() => {
    integrateNow();
  }, [integrateNow]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    exitRambleMode();
    onBack?.();
  }, [exitRambleMode, onBack]);

  // Parse draft frontmatter
  const draftBody = useMemo(() => {
    const { body } = parseFrontmatter(draftContent);
    return body;
  }, [draftContent]);

  // Title is the filename without path and extension
  const headerTitle = useMemo(() => {
    if (!draftFilename) return 'Ramble';
    return draftFilename.split('/').pop()?.replace('.md', '') || 'Ramble';
  }, [draftFilename]);

  if (!isRambleMode) {
    return null;
  }

  return (
    <div className="ramble-view">
      <ItemHeader
        title={headerTitle}
        onBack={handleBack}
        canGoBack={canGoBack}
      >
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
          <div
            className={`ramble-draft-content ${justCrystallized ? 'just-crystallized' : ''}`}
            ref={draftContentRef}
          >
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
            ref={textareaRef}
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
