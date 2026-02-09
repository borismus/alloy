import React, { useRef, useState, useEffect, useCallback, KeyboardEvent } from 'react';
import './AppendOnlyTextarea.css';

interface AppendOnlyTextareaProps {
  value: string;
  onChange: (value: string) => void;
  lockedLength: number;  // Characters before this position are locked
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  onSubmit?: () => void;  // Called on Cmd/Ctrl+Enter
}

/**
 * Textarea that locks the first N characters from editing.
 */
export const AppendOnlyTextarea: React.FC<AppendOnlyTextareaProps> = ({
  value,
  onChange,
  lockedLength,
  placeholder,
  className,
  disabled,
  onSubmit,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastValidValue = useRef(value);

  // Keep track of valid value
  useEffect(() => {
    lastValidValue.current = value;
  }, [value]);

  // Focus and scroll to bottom on mount
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.scrollTop = textarea.scrollHeight;
    }
  }, []);

  // Scroll to bottom when content changes
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.scrollTop = textarea.scrollHeight;
    }
  }, [value]);

  // Prevent selection from starting in locked region
  const handleSelect = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    // If selection starts in locked region, move it to the boundary
    if (start < lockedLength) {
      textarea.setSelectionRange(lockedLength, Math.max(lockedLength, end));
    }
  }, [lockedLength]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const textarea = e.target;

    // Check if the locked prefix is intact
    const lockedPrefix = lastValidValue.current.slice(0, lockedLength);

    if (newValue.startsWith(lockedPrefix)) {
      // Locked region intact, accept the change
      onChange(newValue);
    } else {
      // Locked region was modified, reject the change
      textarea.value = lastValidValue.current;
      // Restore cursor to safe position
      const safePos = Math.max(lockedLength, textarea.selectionStart);
      textarea.setSelectionRange(safePos, safePos);
    }
  }, [lockedLength, onChange]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;

    const textarea = e.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    // Submit on Cmd/Ctrl+Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }

    // Prevent backspace from deleting into locked region
    if (e.key === 'Backspace' && start <= lockedLength && start === end) {
      e.preventDefault();
      return;
    }

    // Prevent delete with selection that includes locked region
    if ((e.key === 'Backspace' || e.key === 'Delete') && start < lockedLength) {
      e.preventDefault();
      return;
    }

    // Prevent cut if selection includes locked region
    if ((e.key === 'x' && (e.metaKey || e.ctrlKey)) && start < lockedLength) {
      e.preventDefault();
      return;
    }
  }, [disabled, lockedLength, onSubmit]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    const start = textarea.selectionStart;

    // If pasting would replace locked content, prevent it
    if (start < lockedLength) {
      e.preventDefault();
      // Paste at the locked boundary instead
      const text = e.clipboardData.getData('text');
      const newValue = value.slice(0, lockedLength) + text + value.slice(Math.max(lockedLength, textarea.selectionEnd));
      onChange(newValue);
      // Set cursor after pasted text
      setTimeout(() => {
        textarea.setSelectionRange(lockedLength + text.length, lockedLength + text.length);
      }, 0);
    }
  }, [lockedLength, value, onChange]);

  // Calculate the height for the crystallized background overlay
  const [overlayHeight, setOverlayHeight] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Measure crystallized text height by counting lines
  useEffect(() => {
    if (!textareaRef.current || lockedLength <= 0) {
      setOverlayHeight(0);
      return;
    }

    const crystallizedText = value.slice(0, lockedLength);
    const lineHeight = 24; // Match CSS line-height

    // Estimate wrapped lines based on average chars per line
    const textarea = textareaRef.current;
    const charsPerLine = Math.floor(textarea.clientWidth / 9); // ~9px per char
    const lines = crystallizedText.split('\n');
    let totalLines = 0;
    for (const line of lines) {
      totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }

    const height = totalLines * lineHeight;
    setOverlayHeight(height);
  }, [value, lockedLength]);

  const handleScroll = useCallback(() => {
    if (textareaRef.current) {
      setScrollOffset(textareaRef.current.scrollTop);
    }
  }, []);

  return (
    <div className={`append-only-wrapper ${className || ''}`}>
      {/* Background overlay for crystallized region */}
      {lockedLength > 0 && overlayHeight > 0 && (
        <div
          className="append-only-overlay"
          style={{
            height: overlayHeight,
            top: 8 - scrollOffset, // Match textarea padding, scroll with content
          }}
          aria-hidden="true"
        />
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onScroll={handleScroll}
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
};
