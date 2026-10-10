import React, { useState, useRef, useMemo, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { ModelInfo, PendingAttachment } from '../types';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useDictation, type DictationMode } from '../hooks/useDictation';
import { useHoldToDictate } from '../hooks/useHoldToDictate';
import { useTextareaProps } from '../utils/textareaProps';
import { ModelSelector } from './ModelSelector';
import { DictationButton } from './DictationButton';
import { AlloyTooltip, Button } from './ui';
import { SlashCommandMenu, SlashCommandItem } from './SlashCommandMenu';
import { skillRegistry } from '../services/skills';
import { slashQuery } from '../utils/slashCommand';
import {
  ATTACHMENT_ACCEPT,
  PDF_MIME,
  formatMegabytes,
  isImageMime,
  modelAcceptsAttachment,
  pdfTooLarge,
  toPendingAttachments,
} from '../utils/attachments';

const MAX_SLASH_ITEMS = 8;

interface ChatInputFormProps {
  /** Return true once the message was accepted for sending or queueing. */
  onSubmit: (message: string, pendingAttachments: PendingAttachment[]) => boolean;
  onStop: () => void;
  isStreaming: boolean;
  model: string;
  onModelChange: (modelKey: string) => void;
  availableModels: ModelInfo[];
  favoriteModels?: string[];
  defaultModel?: string;
  onToggleFavorite?: (modelKey: string) => void;
  onSetDefault?: (modelKey: string) => void;
  sonioxApiKey?: string;
}

export interface ChatInputFormHandle {
  focus: () => void;
  addAttachments: (attachments: PendingAttachment[]) => void;
  setText: (text: string) => void;
}

export const ChatInputForm = React.memo(forwardRef<ChatInputFormHandle, ChatInputFormProps>(({
  onSubmit,
  onStop,
  isStreaming,
  model,
  onModelChange,
  availableModels,
  favoriteModels,
  defaultModel,
  onToggleFavorite,
  onSetDefault,
  sonioxApiKey,
}, ref) => {
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  // Some models can't take some attachment types (PDFs need native support;
  // Alloy never extracts their text). Warn up front rather than let the model
  // answer the bare text as if nothing had been attached.
  const selectedModelInfo = availableModels.find(m => m.key === model);
  const modelLabel = selectedModelInfo?.name ?? 'This model';
  const unsupported = pendingAttachments.filter(a => !modelAcceptsAttachment(selectedModelInfo, a.mimeType));
  const unsupportedKinds = [
    unsupported.some(a => isImageMime(a.mimeType)) && 'images',
    unsupported.some(a => a.mimeType === PDF_MIME) && 'PDFs',
  ].filter(Boolean).join(' or ');
  const oversized = pendingAttachments.filter(a =>
    modelAcceptsAttachment(selectedModelInfo, a.mimeType) && pdfTooLarge(selectedModelInfo, a));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const preDictationTextRef = useRef('');
  // Whether the dictation in progress should send once it finishes. The mic
  // button only dictates: stopping it leaves the transcript in the composer to
  // edit. Send (and releasing push-to-talk Space) is what sends. Sending mid-
  // dictation used to post the partial transcript while recording continued,
  // then post the full one again when the mic stopped.
  const sendOnFinishRef = useRef(false);
  const spaceHoldTextRef = useRef('');
  const textareaProps = useTextareaProps();

  // Slash-command (`/skill_name`) autocomplete.
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const query = slashQuery(input); // null unless typing a leading "/<token>"
  const slashItems = useMemo<SlashCommandItem[]>(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return skillRegistry
      .getSkills()
      .filter((s) => s.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_SLASH_ITEMS)
      .map((s) => ({ name: s.name, description: s.description }));
  }, [query]);
  const slashOpen = !slashDismissed && query !== null && slashItems.length > 0;
  useEffect(() => setSlashActiveIndex(0), [query]);

  const selectSlash = useCallback((item: SlashCommandItem) => {
    setInput(`/${item.name} `);
    setSlashDismissed(false);
    textareaRef.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    addAttachments: (attachments: PendingAttachment[]) => setPendingAttachments(prev => [...prev, ...attachments]),
    setText: (text: string) => setInput(text),
  }));

  useAutoResizeTextarea(textareaRef, input);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // getAsFile() is null for text items.
    const files = Array.from(items)
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null);
    const attachments = await toPendingAttachments(files);
    if (attachments.length === 0) return; // plain text paste
    e.preventDefault();
    setPendingAttachments(prev => [...prev, ...attachments]);
  };

  const handleRemoveAttachment = (index: number) => {
    setPendingAttachments(prev => {
      const removed = prev[index];
      if (removed?.preview) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const attachments = await toPendingAttachments(Array.from(files));
    setPendingAttachments(prev => [...prev, ...attachments]);

    e.target.value = '';
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const doSubmit = useCallback((textOverride?: string): boolean => {
    const sourceText = textOverride ?? input;
    if (!sourceText.trim() && pendingAttachments.length === 0) return false;

    const message = sourceText.trim();
    const attachments = [...pendingAttachments];

    // A restored mobile screen can briefly have no backing conversation while
    // its draft is reconstructed. Never erase a composed prompt unless the
    // parent actually accepted it for sending or queueing.
    if (!onSubmit(message, attachments)) return false;

    setInput('');
    setPendingAttachments([]);
    return true;
  }, [input, pendingAttachments, onSubmit]);

  const transcriptWithPrefix = useCallback((text: string) => {
    const pre = preDictationTextRef.current;
    if (!pre) return text;
    return `${pre}${/\s$/.test(pre) ? '' : ' '}${text}`;
  }, []);

  const handleTranscript = useCallback((text: string) => {
    setInput(transcriptWithPrefix(text));
  }, [transcriptWithPrefix]);

  const handleDictationEndpoint = useCallback((finalText: string) => {
    const fullText = transcriptWithPrefix(finalText);
    // Set the completed transcript first. If the parent rejects submission,
    // doSubmit deliberately leaves this text available for a later retry.
    setInput(fullText);
    const send = sendOnFinishRef.current;
    sendOnFinishRef.current = false;
    if (!send) {
      // Stopped with the mic: the transcript stays for editing. The textarea
      // re-enables once dictation goes idle, so focus on the next frame.
      preDictationTextRef.current = '';
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (doSubmit(fullText)) {
      preDictationTextRef.current = '';
    }
  }, [doSubmit, transcriptWithPrefix]);

  const {
    stream: dictationStream,
    dictationState,
    dictationMode,
    error: dictationError,
    startDictation,
    finishDictation,
    cancelDictation,
  } = useDictation({
    apiKey: sonioxApiKey,
    onTranscript: handleTranscript,
    onEndpoint: handleDictationEndpoint,
  });

  const startVoiceInput = useCallback((mode: DictationMode) => {
    preDictationTextRef.current = input;
    sendOnFinishRef.current = false;
    startDictation(mode);
  }, [input, startDictation]);

  const handleVoiceToggle = useCallback(() => {
    if (dictationState === 'idle') {
      startVoiceInput('manual');
    } else {
      finishDictation();
    }
  }, [dictationState, finishDictation, startVoiceInput]);

  const startSpaceDictation = useCallback(() => {
    // The browser inserted the initial Space normally so ordinary typing stays
    // responsive. Once it becomes a hold gesture, restore the pre-key text and
    // use that as the prefix for the transcript.
    const textBeforeSpace = spaceHoldTextRef.current;
    preDictationTextRef.current = textBeforeSpace;
    setInput(textBeforeSpace);
    // Releasing a held Space is a deliberate "done": push-to-talk sends.
    sendOnFinishRef.current = true;
    startDictation('push-to-talk');
  }, [startDictation]);

  const spaceDictation = useHoldToDictate({
    enabled: Boolean(sonioxApiKey) && dictationState === 'idle' && !slashOpen,
    onStart: startSpaceDictation,
    onFinish: finishDictation,
    onCancel: cancelDictation,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (dictationState !== 'idle') {
      // Finish recording and send the complete transcript once, rather than
      // the partial text showing right now.
      sendOnFinishRef.current = true;
      finishDictation();
      return;
    }
    doSubmit();
  };

  const handleKeyDown = useChatKeyboard({
    onSubmit: doSubmit,
    onStop,
    isStreaming,
  });

  // When the slash menu is open, intercept navigation/selection keys so they
  // don't submit or stop; otherwise fall through to the normal chat keys.
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashActiveIndex((i) => Math.min(i + 1, slashItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectSlash(slashItems[slashActiveIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }

    if (
      e.key === ' '
      && !e.repeat
      && !e.altKey
      && !e.ctrlKey
      && !e.metaKey
      && !e.shiftKey
      && !e.nativeEvent.isComposing
      && sonioxApiKey
      && dictationState === 'idle'
      && !slashOpen
    ) {
      spaceHoldTextRef.current = input;
    }
    spaceDictation.onKeyDown(e);
    handleKeyDown(e);
  };

  const isDictating = dictationState !== 'idle';
  const voiceLabel = dictationMode === 'push-to-talk'
    ? 'Release Space to send voice input'
    : isDictating
      ? 'Stop voice input'
      : 'Start voice input';
  const voiceHint = dictationMode === 'push-to-talk'
    ? 'Release Space to send'
    : isDictating
      ? 'Listening — press to stop and edit, or send with ↑'
      : 'Press to dictate · hold Space for push-to-talk';

  return (
    <form onSubmit={handleSubmit} className="input-form">
      {slashOpen && (
        <SlashCommandMenu
          items={slashItems}
          activeIndex={slashActiveIndex}
          onSelect={selectSlash}
          onHover={setSlashActiveIndex}
        />
      )}
      {unsupported.length > 0 && (
        <p className="attachment-warning" role="status">
          {modelLabel} can&apos;t read {unsupportedKinds} — {unsupported.length === 1 ? 'this attachment' : 'these attachments'} will be ignored. Switch models to send {unsupported.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {oversized.map(a => (
        <p key={a.name} className="attachment-warning" role="status">
          {a.name} is {formatMegabytes(a.data.length)}, but {modelLabel} only receives PDFs up to {formatMegabytes(selectedModelInfo?.maxPdfBytes ?? 0)}. Shrink it or switch models.
        </p>
      ))}
      {pendingAttachments.length > 0 && (
        <div className="pending-images">
          {pendingAttachments.map((attachment, idx) => (
            <div key={idx} className={attachment.preview ? 'pending-image' : 'pending-file'}>
              {attachment.preview
                ? <img src={attachment.preview} alt={`Pending ${idx + 1}`} />
                : <span className="attachment-chip" title={attachment.name}>{attachment.name}</span>}
              <button
                type="button"
                className="remove-image"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => handleRemoveAttachment(idx)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-row">
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <AlloyTooltip content="Attach image, PDF, or Markdown">
          <Button
            type="button"
            variant="secondary"
            size="composer"
            data-composer-control="attach"
            onPress={handleAttachClick}
            aria-label="Attach file"
          >
            +
          </Button>
        </AlloyTooltip>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSlashDismissed(false);
          }}
          onKeyDown={handleTextareaKeyDown}
          onPaste={handlePaste}
          placeholder={isDictating ? 'Listening...' : 'Send a message...'}
          disabled={isDictating}
          rows={1}
          {...textareaProps}
        />
        <div className="model-selector-container">
          <ModelSelector
            value={model}
            onChange={onModelChange}
            disabled={false}
            models={availableModels}
            favoriteModels={favoriteModels}
            defaultModel={defaultModel}
            onToggleFavorite={onToggleFavorite}
            onSetDefault={onSetDefault}
          />
        </div>
        {sonioxApiKey && (
          <AlloyTooltip content={voiceHint}>
            <DictationButton
              dictationState={dictationState}
              stream={dictationStream}
              data-dictation-mode={dictationMode ?? undefined}
              onPress={handleVoiceToggle}
              isDisabled={dictationState === 'stopping'}
              aria-label={voiceLabel}
              title={voiceHint}
            />
          </AlloyTooltip>
        )}
        {isStreaming && !input.trim() && pendingAttachments.length === 0 ? (
          <AlloyTooltip content="Stop generating">
            <Button
              type="button"
              variant="danger"
              size="composer"
              data-composer-control="send"
              onPress={onStop}
              aria-label="Stop generating"
            >
              ■
            </Button>
          </AlloyTooltip>
        ) : (
          <AlloyTooltip content={isStreaming ? 'Queue message' : 'Send message'}>
            <Button
              type="submit"
              variant="primary"
              size="composer"
              data-composer-control="send"
              isDisabled={!isDictating && !input.trim() && pendingAttachments.length === 0}
              aria-label={isStreaming ? 'Queue message' : 'Send message'}
            >
              ↑
            </Button>
          </AlloyTooltip>
        )}
      </div>
      {dictationError && (
        <div className="dictation-error" role="alert">{dictationError}</div>
      )}
    </form>
  );
}));
