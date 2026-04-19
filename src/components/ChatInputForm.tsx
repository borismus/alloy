import React, { useState, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { ModelInfo } from '../types';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { useTextareaProps } from '../utils/textareaProps';
import { ModelSelector } from './ModelSelector';

export interface PendingImage {
  data: Uint8Array;
  mimeType: string;
  preview: string;
}

interface ChatInputFormProps {
  onSubmit: (message: string, pendingImages: PendingImage[]) => Promise<void>;
  onStop: () => void;
  isStreaming: boolean;
  model: string;
  onModelChange: (modelKey: string) => void;
  availableModels: ModelInfo[];
  favoriteModels?: string[];
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
}, ref) => {
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaProps = useTextareaProps();

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    addImages: (images: PendingImage[]) => setPendingImages(prev => [...prev, ...images]),
    setText: (text: string) => setInput(text),
  }));

  useAutoResizeTextarea(textareaRef, input);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

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

  const doSubmit = useCallback(() => {
    if (!input.trim() && pendingImages.length === 0) return;

    const message = input.trim();
    const images = [...pendingImages];

    setInput('');
    setPendingImages([]);

    onSubmit(message, images);
  }, [input, pendingImages, onSubmit]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const handleKeyDown = useChatKeyboard({
    onSubmit: doSubmit,
    onStop,
    isStreaming,
  });

  return (
    <form onSubmit={handleSubmit} className="input-form">
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
        <button
          type="button"
          className="attach-button"
          onClick={handleAttachClick}
          aria-label="Attach image"
        >
          +
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Send a message..."
          rows={1}
          {...textareaProps}
        />
        <ModelSelector
          value={model}
          onChange={onModelChange}
          disabled={false}
          models={availableModels}
          favoriteModels={favoriteModels}
        />
        {isStreaming && !input.trim() && pendingImages.length === 0 ? (
          <button
            type="button"
            onClick={onStop}
            className="send-button stop-button"
            aria-label="Stop generating"
          >
            ■
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() && pendingImages.length === 0}
            className="send-button"
            aria-label={isStreaming ? 'Queue message' : 'Send message'}
          >
            ↑
          </button>
        )}
      </div>
    </form>
  );
}));
