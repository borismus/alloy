import React, { useRef, useEffect, useCallback, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useTextareaProps } from '../utils/textareaProps';
import './AppendOnlyTextarea.css';

interface AppendOnlyTextareaProps {
  value: string;
  onChange: (value: string) => void;
  lockedLength: number;  // Characters before this position are locked (crystallized)
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  onSubmit?: () => void;  // Called on Cmd/Ctrl+Enter
}

export interface AppendOnlyTextareaHandle {
  focus: () => void;
  scrollToBottom: () => void;
}

/**
 * Single textarea that shows all text. RambleContext handles protecting
 * crystallized text - if user tries to modify it, the change is rejected
 * and the textarea stays in sync with the valid state.
 *
 * A backdrop div behind the textarea highlights crystallized text with
 * a gray background, scrolling in sync with the textarea.
 */
export const AppendOnlyTextarea = forwardRef<AppendOnlyTextareaHandle, AppendOnlyTextareaProps>(function AppendOnlyTextarea({
  value,
  onChange,
  lockedLength,
  placeholder,
  className,
  disabled,
  onSubmit,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const textareaProps = useTextareaProps();

  // Sync backdrop scroll position with textarea
  const syncScroll = useCallback(() => {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    scrollToBottom: () => {
      if (textareaRef.current) {
        textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
        syncScroll();
      }
    },
  }));

  // Focus and position cursor at end on mount
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
      textarea.scrollTop = textarea.scrollHeight;
      syncScroll();
    }
  }, []);

  // Scroll to bottom when content changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
      syncScroll();
    }
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  }, [onChange]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }
  }, [disabled, onSubmit]);

  return (
    <div className={`append-only-wrapper ${className || ''}`}>
      <div
        ref={backdropRef}
        className="append-only-backdrop"
        aria-hidden="true"
      >
        {lockedLength > 0 && (
          <span className="crystallized-bg">{value.slice(0, lockedLength)}</span>
        )}
        <span>{value.slice(lockedLength) + '\n'}</span>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        placeholder={placeholder}
        className="append-only-textarea"
        disabled={disabled}
        {...textareaProps}
      />
    </div>
  );
});
