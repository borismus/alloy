import { useState, useRef, useEffect, useCallback } from 'react';
import { useAutoResizeTextarea } from './useAutoResizeTextarea';
import { useGlobalEscape } from './useGlobalEscape';
import { useAutoScroll } from './useAutoScroll';
import { useClickOutside } from './useClickOutside';

interface UseMultiModelChatOptions {
  conversationId: string;
  hasMessages: boolean;
  isAnyStreaming: boolean;
  stopAll: () => void;
  autoScrollDependencies: unknown[];
}

export function useMultiModelChat({
  conversationId,
  hasMessages,
  isAnyStreaming,
  stopAll,
  autoScrollDependencies,
}: UseMultiModelChatOptions) {
  const [input, setInput] = useState('');
  const [hasSubmittedFirst, setHasSubmittedFirst] = useState(hasMessages);
  const [showModelsDropdown, setShowModelsDropdown] = useState(false);
  const [currentUserMessage, setCurrentUserMessage] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-resize textarea as content changes
  useAutoResizeTextarea(textareaRef, input);

  // Global escape to stop streaming
  useGlobalEscape(stopAll, isAnyStreaming);

  // Close dropdown on outside click
  useClickOutside(dropdownRef, () => setShowModelsDropdown(false), showModelsDropdown);

  // Auto-scroll when new content arrives
  const { setShouldAutoScroll, handleScroll } = useAutoScroll({
    endRef: messagesEndRef,
    dependencies: autoScrollDependencies,
  });

  // Focus textarea on mount if no messages
  useEffect(() => {
    if (!hasMessages && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [conversationId]);

  // Clear current user message when streaming ends
  useEffect(() => {
    if (!isAnyStreaming) {
      setCurrentUserMessage(null);
    }
  }, [isAnyStreaming]);

  // Focus input method for imperative handle
  const focusInput = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  // Prepare for submit (common pattern)
  const prepareSubmit = useCallback(
    (trimmedInput: string) => {
      setInput('');
      setHasSubmittedFirst(true);
      setCurrentUserMessage(trimmedInput);
      setShouldAutoScroll(true);
    },
    [setShouldAutoScroll]
  );

  return {
    // State
    input,
    setInput,
    hasSubmittedFirst,
    showModelsDropdown,
    setShowModelsDropdown,
    currentUserMessage,

    // Refs
    textareaRef,
    dropdownRef,
    messagesContainerRef,
    messagesEndRef,

    // Handlers
    handleScroll,
    focusInput,
    prepareSubmit,
    stopAll,
  };
}
