import React, { useRef, useEffect, useCallback, KeyboardEvent, useMemo } from 'react';
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
 * Uses a backdrop div to show locked text with gray background,
 * unlocked text with white background, and a gradient transition line.
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
  const backdropRef = useRef<HTMLDivElement>(null);
  const lastValidValue = useRef(value);

  // Keep track of valid value
  useEffect(() => {
    lastValidValue.current = value;
  }, [value]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea and sync backdrop height
  useEffect(() => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = `${textarea.scrollHeight}px`;
      textarea.style.height = newHeight;
      if (backdrop) {
        backdrop.style.height = newHeight;
      }
    }
  }, [value]);

  // Sync backdrop scroll with textarea
  const handleScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (textarea && backdrop) {
      backdrop.scrollTop = textarea.scrollTop;
    }
  }, []);

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

  // Split text into regions for rendering
  const textRegions = useMemo(() => {
    if (lockedLength === 0) {
      // No locked content
      return {
        fullyLockedLines: '',
        transitionLineLocked: '',
        transitionLineUnlocked: '',
        fullyUnlockedLines: value,
        hasTransitionLine: false,
      };
    }

    const lockedText = value.slice(0, lockedLength);
    const unlockedText = value.slice(lockedLength);

    // Find the last newline in locked text
    const lastNewlineInLocked = lockedText.lastIndexOf('\n');

    // Find the first newline in unlocked text
    const firstNewlineInUnlocked = unlockedText.indexOf('\n');

    if (lastNewlineInLocked === -1) {
      // No complete locked lines - everything is on the transition line
      return {
        fullyLockedLines: '',
        transitionLineLocked: lockedText,
        transitionLineUnlocked: firstNewlineInUnlocked === -1 ? unlockedText : unlockedText.slice(0, firstNewlineInUnlocked),
        fullyUnlockedLines: firstNewlineInUnlocked === -1 ? '' : unlockedText.slice(firstNewlineInUnlocked),
        hasTransitionLine: true,
      };
    }

    // We have complete locked lines
    const fullyLockedLines = lockedText.slice(0, lastNewlineInLocked + 1); // Include the newline
    const transitionLineLocked = lockedText.slice(lastNewlineInLocked + 1);

    if (firstNewlineInUnlocked === -1) {
      // No complete unlocked lines
      return {
        fullyLockedLines,
        transitionLineLocked,
        transitionLineUnlocked: unlockedText,
        fullyUnlockedLines: '',
        hasTransitionLine: transitionLineLocked.length > 0 || unlockedText.length > 0,
      };
    }

    return {
      fullyLockedLines,
      transitionLineLocked,
      transitionLineUnlocked: unlockedText.slice(0, firstNewlineInUnlocked),
      fullyUnlockedLines: unlockedText.slice(firstNewlineInUnlocked),
      hasTransitionLine: true,
    };
  }, [value, lockedLength]);

  return (
    <div className={`append-only-wrapper ${className || ''}`}>
      {/* Backdrop showing styled text */}
      <div
        ref={backdropRef}
        className="append-only-backdrop"
        aria-hidden="true"
      >
        {textRegions.fullyLockedLines && (
          <span className="fully-locked">{textRegions.fullyLockedLines}</span>
        )}
        {textRegions.hasTransitionLine && (
          <span className="transition-line">
            <span className="locked-part">{textRegions.transitionLineLocked}</span>
            <span className="unlocked-part">{textRegions.transitionLineUnlocked}</span>
          </span>
        )}
        {textRegions.fullyUnlockedLines && (
          <span className="fully-unlocked">{textRegions.fullyUnlockedLines}</span>
        )}
        {!value && <span className="placeholder-text">{placeholder}</span>}
      </div>
      {/* Actual textarea (text is transparent, caret visible) */}
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
