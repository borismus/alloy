import React from 'react';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { TEXTAREA_PROPS } from '../utils/textareaProps';

interface MultiModelInputFormProps {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  placeholder: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  showDropdown: boolean;
  onToggleDropdown: () => void;
  dropdownButtonContent: React.ReactNode;
  dropdownContent: React.ReactNode;
  dropdownClassName?: string;
}

export const MultiModelInputForm: React.FC<MultiModelInputFormProps> = ({
  input,
  onInputChange,
  onSubmit,
  onStop,
  isStreaming,
  placeholder,
  textareaRef,
  dropdownRef,
  showDropdown,
  onToggleDropdown,
  dropdownButtonContent,
  dropdownContent,
  dropdownClassName = 'comparison-model-indicator-wrapper',
}) => {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  const handleKeyDown = useChatKeyboard({
    onSubmit,
    onStop,
    isStreaming,
  });

  return (
    <form onSubmit={handleSubmit} className="input-form">
      <div className="input-row">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isStreaming}
          rows={1}
          {...TEXTAREA_PROPS}
        />
        <div className={dropdownClassName} ref={dropdownRef}>
          <button
            type="button"
            className={dropdownClassName.replace('-wrapper', '')}
            onClick={onToggleDropdown}
          >
            {dropdownButtonContent}
            <svg
              className={`dropdown-arrow ${showDropdown ? 'open' : ''}`}
              width="12"
              height="8"
              viewBox="0 0 12 8"
              fill="none"
            >
              <path
                d="M1 1.5L6 6.5L11 1.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {showDropdown && dropdownContent}
        </div>
        {isStreaming ? (
          <button type="button" onClick={onStop} className="send-button stop-button">
            ■
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="send-button">
            ↑
          </button>
        )}
      </div>
    </form>
  );
};
