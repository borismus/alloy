import React, { useCallback, useRef, useState } from 'react';
import { ModelInfo, Message } from '../types';
import { executeChatOnce } from '../services/server-streaming';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useTextareaProps } from '../utils/textareaProps';
import { hasDiff } from '../utils/lineDiff';
import { ModelSelector } from './ModelSelector';
import { DiffView } from './DiffView';
import './AiEditPanel.css';

interface AiEditPanelProps {
  /** Composer placeholder, e.g. "Edit this note". */
  placeholder: string;
  /** Current document text — what we diff against and send to the model. */
  getCurrentContent: () => string;
  /** Build the system prompt for a one-shot rewrite of the current document. */
  buildSystemPrompt: (current: string) => string;
  /** Persist the confirmed rewrite. May throw to surface a validation error. */
  applyNewContent: (newContent: string) => Promise<void>;
  /**
   * Turn the model's raw output into the exact text that gets diffed AND
   * applied — e.g. merge a partial patch onto the current document, or re-dump
   * YAML in canonical order. Keeping diff and apply on the same resolved text is
   * what prevents the diff from lying about what Confirm will do.
   */
  resolveProposal?: (raw: string) => string;
  /** Model used to perform the edit; the picker starts here. */
  defaultModel: string;
  availableModels: ModelInfo[];
  favoriteModels?: string[];
  onToggleFavorite?: (modelKey: string) => void;
}

/** Strip a single surrounding ``` code fence, if the model wrapped its output. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return (match ? match[1] : trimmed);
}

// Pencil — signals "edit" rather than the chat composer's "send" arrow.
function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export const AiEditPanel: React.FC<AiEditPanelProps> = ({
  placeholder,
  getCurrentContent,
  buildSystemPrompt,
  applyNewContent,
  resolveProposal,
  defaultModel,
  availableModels,
  favoriteModels,
  onToggleFavorite,
}) => {
  const [input, setInput] = useState('');
  const [model, setModel] = useState(defaultModel);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Snapshot of the document at generate-time, plus the model's proposal.
  const [proposal, setProposal] = useState<{ before: string; after: string } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaProps = useTextareaProps();

  useAutoResizeTextarea(textareaRef, input);

  const doSubmit = useCallback(async () => {
    const instruction = input.trim();
    if (!instruction || isGenerating) return;

    const before = getCurrentContent();
    setError(null);
    setIsGenerating(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const messages: Message[] = [
        { role: 'user', timestamp: new Date().toISOString(), content: instruction },
      ];
      const { content } = await executeChatOnce(model, messages, buildSystemPrompt(before), {
        signal: controller.signal,
      });
      const stripped = stripCodeFence(content);
      const after = resolveProposal ? resolveProposal(stripped) : stripped;
      setProposal({ before, after });
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Failed to generate a proposal.');
      }
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  }, [input, isGenerating, getCurrentContent, model, buildSystemPrompt, resolveProposal]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!proposal) return;
    setIsApplying(true);
    setError(null);
    try {
      await applyNewContent(proposal.after);
      setProposal(null);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply the change.');
    } finally {
      setIsApplying(false);
    }
  }, [proposal, applyNewContent]);

  const handleDiscard = useCallback(() => {
    setProposal(null);
    setError(null);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useChatKeyboard({ onSubmit: doSubmit, onStop: handleStop, isStreaming: isGenerating });

  // Proposal review — the diff is the main event, shown by default.
  if (proposal) {
    const changed = hasDiff(proposal.before, proposal.after);
    return (
      <div className="ai-edit-panel">
        <div className="ai-edit-proposal">
          {changed ? (
            <DiffView oldText={proposal.before} newText={proposal.after} />
          ) : (
            <div className="ai-edit-nochange">No changes proposed.</div>
          )}
          {error && <div className="ai-edit-error">{error}</div>}
          <div className="ai-edit-actions">
            <button type="button" className="ai-edit-btn" onClick={handleDiscard} disabled={isApplying}>
              Discard
            </button>
            {changed && (
              <button
                type="button"
                className="ai-edit-btn ai-edit-btn-primary"
                onClick={handleConfirm}
                disabled={isApplying}
              >
                {isApplying ? 'Applying…' : 'Confirm'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      className="ai-edit-panel"
      onSubmit={(e) => {
        e.preventDefault();
        doSubmit();
      }}
    >
      {error && <div className="ai-edit-error">{error}</div>}
      <div className="ai-edit-row">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={isGenerating}
          {...textareaProps}
        />
        <ModelSelector
          value={model}
          onChange={setModel}
          disabled={isGenerating}
          models={availableModels}
          favoriteModels={favoriteModels}
          onToggleFavorite={onToggleFavorite}
        />
        {isGenerating ? (
          <button type="button" className="ai-edit-submit stop" onClick={handleStop} aria-label="Stop">
            ■
          </button>
        ) : (
          <button
            type="submit"
            className="ai-edit-submit"
            disabled={!input.trim()}
            aria-label="Propose edit"
            title="Propose edit"
          >
            <PencilIcon />
          </button>
        )}
      </div>
    </form>
  );
};
