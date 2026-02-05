import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { NoteInfo } from '../types';
import { rambleService } from '../services/ramble';
import { useRambleContext } from '../contexts/RambleContext';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import { AppendOnlyTextarea } from './AppendOnlyTextarea';
import './RambleView.css';
import './MarkdownContent.css';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

interface RambleViewProps {
  notes: NoteInfo[];
  model: string;
  onNavigateToNote?: (noteFilename: string) => void;
  onExit?: () => void;
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
  onExit,
}) => {
  const {
    isRambleMode,
    activeDraftFilename,
    isProcessing,
    updateRawInput,
    crystallizeNow,
    ripDraft,
    setActiveDraft,
    exitRambleMode,
    integrateExistingRamble,
  } = useRambleContext();

  const [draftContent, setDraftContent] = useState('');
  const [rambleLog, setRambleLog] = useState('');
  const [lockedLogLength, setLockedLogLength] = useState(0);
  const [localInput, setLocalInput] = useState('');
  const crystallizeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastCrystallizeTimeRef = useRef<number>(0);
  const draftContentRef = useRef<HTMLDivElement>(null);
  const initialDraftLoadedRef = useRef<string | null>(null);

  // Load ramble log on mount, or load draft's rawInput if entering with a draft
  useEffect(() => {
    const loadInitialContent = async () => {
      // If we have an active draft and haven't loaded its rawInput yet, load it
      if (activeDraftFilename && initialDraftLoadedRef.current !== activeDraftFilename) {
        const rawInput = await rambleService.getDraftRawInput(activeDraftFilename);
        if (rawInput) {
          // Use the draft's rawInput as the initial log content
          setRambleLog(rawInput);
          setLockedLogLength(rawInput.length);
          initialDraftLoadedRef.current = activeDraftFilename;
          return;
        }
      }

      // Otherwise load the global ramble log
      if (!activeDraftFilename) {
        const log = await rambleService.getRambleLog();
        setRambleLog(log);
        setLockedLogLength(log.length);
        initialDraftLoadedRef.current = null;
      }
    };
    loadInitialContent();
  }, [activeDraftFilename]);

  // Load draft content when activeDraftFilename changes
  useEffect(() => {
    if (!activeDraftFilename) {
      setDraftContent('');
      return;
    }

    const loadDraft = async () => {
      const vaultPath = rambleService.getVaultPath();
      if (!vaultPath) return;

      try {
        const { join } = await import('@tauri-apps/api/path');
        const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
        const fullPath = await join(vaultPath, activeDraftFilename);
        if (await exists(fullPath)) {
          const content = await readTextFile(fullPath);
          setDraftContent(content);
        }
      } catch (error) {
        console.error('[RambleView] Failed to load draft:', error);
      }
    };

    loadDraft();
    // Poll for updates while processing
    const interval = setInterval(loadDraft, 1000);
    return () => clearInterval(interval);
  }, [activeDraftFilename, isProcessing]);

  // Auto-scroll draft content when it updates
  useEffect(() => {
    if (draftContentRef.current && draftContent) {
      draftContentRef.current.scrollTop = draftContentRef.current.scrollHeight;
    }
  }, [draftContent]);

  // Handle input changes - append to log and trigger crystallization
  const handleInputChange = useCallback(async (newValue: string) => {
    // Get the new text that was added
    const newText = newValue.slice(lockedLogLength);
    setLocalInput(newText);
    updateRawInput(newText);

    // Clear existing timer
    if (crystallizeTimerRef.current) {
      clearTimeout(crystallizeTimerRef.current);
    }

    // If no active draft and we have content, create one with initial rawInput
    if (!activeDraftFilename && newText.trim().length > 10) {
      try {
        const fullInput = rambleLog + newText;
        const filename = await rambleService.getOrCreateRambleNote(fullInput);
        setActiveDraft(filename);
        initialDraftLoadedRef.current = filename;
      } catch (error) {
        console.error('[RambleView] Failed to create draft:', error);
      }
    }

    // Schedule crystallization (debounced)
    const now = Date.now();
    const timeSinceLastCrystallize = now - lastCrystallizeTimeRef.current;
    const delay = timeSinceLastCrystallize < 2000 ? 3000 : 1500;

    crystallizeTimerRef.current = setTimeout(async () => {
      if (activeDraftFilename && newText.trim()) {
        lastCrystallizeTimeRef.current = Date.now();
        await crystallizeNow(model, notes);
        // After crystallization, move processed text to "locked" portion
        // This grays it out visually while keeping the full text visible
        setRambleLog(prev => prev + newText);
        setLockedLogLength(prev => prev + newText.length);
        setLocalInput('');
      }
    }, delay);
  }, [lockedLogLength, activeDraftFilename, model, notes, updateRawInput, crystallizeNow, setActiveDraft]);

  // Handle rip - detach the draft
  const handleRip = useCallback(async () => {
    // Save rawInput to the draft's frontmatter before detaching
    const fullContent = rambleLog + localInput;
    if (activeDraftFilename && fullContent.trim()) {
      await rambleService.updateDraftRawInput(activeDraftFilename, fullContent);
    }

    // Save full log with separator marking end of this draft session
    if (fullContent.trim()) {
      const contentWithSeparator = fullContent + '\n\n---\n\n';
      await rambleService.writeLog(contentWithSeparator);
      setRambleLog(contentWithSeparator);
      setLockedLogLength(contentWithSeparator.length);
      setLocalInput('');
      updateRawInput('');
    }
    initialDraftLoadedRef.current = null;
    ripDraft();
  }, [rambleLog, localInput, activeDraftFilename, ripDraft, updateRawInput]);

  // Handle integrate
  const handleIntegrate = useCallback(async () => {
    if (activeDraftFilename) {
      // Save full log and rawInput first
      const fullContent = rambleLog + localInput;
      if (fullContent.trim()) {
        await rambleService.writeLog(fullContent);
        await rambleService.updateDraftRawInput(activeDraftFilename, fullContent);
      }
      await integrateExistingRamble(activeDraftFilename, model, notes);
    }
  }, [activeDraftFilename, rambleLog, localInput, model, notes, integrateExistingRamble]);

  // Handle exit
  const handleExit = useCallback(async () => {
    // Save full log and rawInput to draft
    const fullContent = rambleLog + localInput;
    if (fullContent.trim()) {
      await rambleService.writeLog(fullContent);
      // Also save rawInput to draft's frontmatter if we have an active draft
      if (activeDraftFilename) {
        await rambleService.updateDraftRawInput(activeDraftFilename, fullContent);
      }
    }
    initialDraftLoadedRef.current = null;
    exitRambleMode();
    onExit?.();
  }, [rambleLog, localInput, activeDraftFilename, exitRambleMode, onExit]);

  // Parse draft frontmatter
  const { body: draftBody } = useMemo(() => parseFrontmatter(draftContent), [draftContent]);

  // Process wiki-links in draft content
  const processedDraftContent = useMemo(() => processWikiLinks(draftBody), [draftBody]);

  // Create markdown components
  const markdownComponents = useMemo(() => {
    return createMarkdownComponents({ onNavigateToNote });
  }, [onNavigateToNote]);

  // Combined value for AppendOnlyTextarea (log + current input)
  const combinedValue = rambleLog + localInput;

  console.log('[RambleView] Rendering', {
    isRambleMode,
    activeDraftFilename,
    draftContentLength: draftContent.length,
    draftBody: draftBody?.slice(0, 100),
    rambleLogLength: rambleLog.length,
  });

  if (!isRambleMode) {
    return null;
  }

  return (
    <div className="ramble-view">
      {/* Header */}
      <div className="ramble-header">
        <div className="ramble-header-title">
          <h2>Ramble</h2>
          {activeDraftFilename && (
            <span className="draft-indicator">
              {isProcessing ? 'Processing...' : 'Draft active'}
            </span>
          )}
        </div>
        <div className="ramble-header-actions">
          {activeDraftFilename && (
            <>
              <button
                className="btn-small"
                onClick={handleRip}
                disabled={isProcessing}
                title="Detach this draft and start fresh"
              >
                Rip
              </button>
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
          <button
            className="btn-small"
            onClick={handleExit}
            title="Exit ramble mode"
          >
            Done
          </button>
        </div>
      </div>

      {/* Draft content area - only shown when there's an active draft */}
      {activeDraftFilename && draftBody && (
        <div className="ramble-draft-section">
          <div className="ramble-draft-header">
            <h3>Draft</h3>
          </div>
          <div className="ramble-draft-content markdown-content" ref={draftContentRef}>
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={markdownComponents}
            >
              {processedDraftContent}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Ramble log input - always visible */}
      <div className="ramble-log-section">
        <div className="ramble-log-header">
          <h3>Log</h3>
          <span className="ramble-log-hint">
            {activeDraftFilename
              ? 'Type to update the draft...'
              : 'Start typing to create a draft...'}
          </span>
        </div>
        <div className="ramble-log-input">
          <AppendOnlyTextarea
            value={combinedValue}
            onChange={handleInputChange}
            lockedLength={lockedLogLength}
            placeholder="What's on your mind? Start typing..."
            disabled={isProcessing}
          />
        </div>
      </div>
    </div>
  );
};
