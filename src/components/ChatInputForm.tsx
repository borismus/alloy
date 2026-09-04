import React, { useState, useRef, useMemo, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { ModelInfo } from '../types';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useDictation, type DictationMode } from '../hooks/useDictation';
import { useVoiceInputPress } from '../hooks/useVoiceInputPress';
import { useTextareaProps } from '../utils/textareaProps';
import { ModelSelector } from './ModelSelector';
import { DictationButton } from './DictationButton';
import { AlloyTooltip, Button } from './ui';
import { SlashCommandMenu, SlashCommandItem } from './SlashCommandMenu';
import { skillRegistry } from '../services/skills';
import { slashQuery } from '../utils/slashCommand';

const MAX_SLASH_ITEMS = 8;

export interface PendingImage {
  data: Uint8Array;
  mimeType: string;
  preview: string;
}

interface ChatInputFormProps {
  /** Return true once the message was accepted for sending or queueing. */
  onSubmit: (message: string, pendingImages: PendingImage[]) => boolean;
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
  addImages: (images: PendingImage[]) => void;
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
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // Some providers can't accept images at all (codex exec takes a single text
  // prompt). They used to drop the attachment silently and answer the bare
  // text, so the model would insist no image had been sent. Absence means
  // supported — only an explicit `false` blocks.
  const selectedModelInfo = availableModels.find(m => m.key === model);
  const modelAcceptsImages = selectedModelInfo?.supportsImages !== false;
  const modelLabel = selectedModelInfo?.name ?? 'This model';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const preDictationTextRef = useRef('');
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
    addImages: (images: PendingImage[]) => setPendingImages(prev => [...prev, ...images]),
    setText: (text: string) => setInput(text),
  }));

  useAutoResizeTextarea(textareaRef, input);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Let the paste fall through as text rather than silently swallowing it.
    if (!modelAcceptsImages) return;

    const validImageTypes = ['image/png', 'image/jpeg', 'image/webp'];

    for (const item of Array.from(items)) {
      if (!validImageTypes.includes(item.type)) continue;

      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      const arrayBuffer = await blob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const preview = URL.createObjectURL(blob);

      setPendingImages(prev => [...prev, { data, mimeType: item.type, preview }]);
    }
  };

  const handleRemoveImage = (index: number) => {
    setPendingImages(prev => {
      const removed = prev[index];
      if (removed) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const validImageTypes = ['image/png', 'image/jpeg', 'image/webp'];
    const imageExtensions = /\.(png|jpe?g|webp)$/i;

    for (const file of Array.from(files)) {
      let mimeType = file.type;
      const isValidMime = validImageTypes.includes(mimeType);
      const hasImageExtension = imageExtensions.test(file.name);

      if (!isValidMime && !hasImageExtension) continue;

      if (!isValidMime && hasImageExtension) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext === 'png') mimeType = 'image/png';
        else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'webp') mimeType = 'image/webp';
        else continue;
      }

      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const preview = URL.createObjectURL(file);
      setPendingImages(prev => [...prev, { data, mimeType, preview }]);
    }

    e.target.value = '';
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const doSubmit = useCallback((textOverride?: string): boolean => {
    const sourceText = textOverride ?? input;
    if (!sourceText.trim() && pendingImages.length === 0) return false;

    const message = sourceText.trim();
    const images = [...pendingImages];

    // A restored mobile screen can briefly have no backing conversation while
    // its draft is reconstructed. Never erase a composed prompt unless the
    // parent actually accepted it for sending or queueing.
    if (!onSubmit(message, images)) return false;

    setInput('');
    setPendingImages([]);
    return true;
  }, [input, pendingImages, onSubmit]);

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
    if (doSubmit(fullText)) {
      preDictationTextRef.current = '';
    }
  }, [doSubmit, transcriptWithPrefix]);

  const {
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
    startDictation(mode);
  }, [input, startDictation]);

  const voicePress = useVoiceInputPress({
    isActive: dictationState !== 'idle',
    onStartAutomatic: () => startVoiceInput('one-shot'),
    onStartPushToTalk: () => startVoiceInput('push-to-talk'),
    onFinish: finishDictation,
    onCancel: cancelDictation,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
    handleKeyDown(e);
  };

  const isDictating = dictationState !== 'idle';
  const voiceLabel = dictationMode === 'push-to-talk'
    ? 'Release to send voice input'
    : isDictating
      ? 'Finish and send voice input'
      : 'Start voice input';
  const voiceHint = dictationMode === 'push-to-talk'
    ? 'Release to send'
    : isDictating
      ? 'Listening — press to send'
      : 'Tap to speak · hold for push-to-talk';

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
      {pendingImages.length > 0 && !modelAcceptsImages && (
        <p className="attachment-warning" role="status">
          {modelLabel} can&apos;t accept images — {pendingImages.length === 1 ? 'this attachment' : 'these attachments'} will be ignored. Switch models to send {pendingImages.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {pendingImages.length > 0 && (
        <div className="pending-images">
          {pendingImages.map((img, idx) => (
            <div key={idx} className="pending-image">
              <img src={img.preview} alt={`Pending ${idx + 1}`} />
              <button
                type="button"
                className="remove-image"
                onClick={() => handleRemoveImage(idx)}
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
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <AlloyTooltip
          content={modelAcceptsImages ? 'Attach image' : `${modelLabel} can't accept images`}
        >
          <Button
            type="button"
            variant="secondary"
            size="composer"
            data-composer-control="attach"
            onPress={handleAttachClick}
            aria-label={modelAcceptsImages ? 'Attach image' : `${modelLabel} can't accept images`}
            isDisabled={!modelAcceptsImages}
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
              data-dictation-mode={dictationMode ?? undefined}
              {...voicePress}
              isDisabled={dictationState === 'stopping'}
              aria-label={voiceLabel}
              title={voiceHint}
            />
          </AlloyTooltip>
        )}
        {isStreaming && !input.trim() && pendingImages.length === 0 ? (
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
              isDisabled={!input.trim() && pendingImages.length === 0}
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
