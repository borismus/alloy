import { useCallback, KeyboardEvent } from 'react';

interface UseChatKeyboardOptions {
  onSubmit: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

export function useChatKeyboard(
  options: UseChatKeyboardOptions
): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  const { onSubmit, onStop, isStreaming } = options;

  return useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends message, Shift+Enter or Option+Enter creates newline
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        onSubmit();
      }

      // Escape stops streaming
      if (e.key === 'Escape' && isStreaming && onStop) {
        e.preventDefault();
        onStop();
      }
    },
    [onSubmit, onStop, isStreaming]
  );
}
