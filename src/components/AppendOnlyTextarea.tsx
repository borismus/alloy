import React, { useRef, useEffect, useCallback, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
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
 */
export const AppendOnlyTextarea = forwardRef<AppendOnlyTextareaHandle, AppendOnlyTextareaProps>(function AppendOnlyTextarea({
  value,
  onChange,
  lockedLength: _lockedLength, // Unused - RambleContext handles protection
  placeholder,
  className,
  disabled,
  onSubmit,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    scrollToBottom: () => {
      if (textareaRef.current) {
        textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
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
    }
  }, []);

  // Scroll to bottom when content changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Just pass the new value - RambleContext will validate and reject
    // any modifications to the crystallized portion
    onChange(e.target.value);
  }, [onChange]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;

    // Submit on Cmd/Ctrl+Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }
  }, [disabled, onSubmit]);

  return (
    <div className={`append-only-wrapper ${className || ''}`}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="append-only-textarea"
        disabled={disabled}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
});
