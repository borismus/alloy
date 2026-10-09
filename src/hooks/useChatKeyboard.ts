import { useCallback, KeyboardEvent } from 'react';

interface UseChatKeyboardOptions {
  onSubmit: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

/**
 * On a touchscreen device Return inserts a line break and the send button
 * sends: a phone keyboard has no Shift or Option to hold, so Enter-to-send left
 * no way to type a newline. Same touchscreen test as the message `client`
 * stamp (useSendMessage), so a narrow desktop window still sends on Enter.
 */
function enterInsertsNewline(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

export function useChatKeyboard(
  options: UseChatKeyboardOptions
): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  const { onSubmit, onStop, isStreaming } = options;

  return useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends message, Shift+Enter or Option+Enter creates newline.
      // Never mid-composition (IME, dictation): that Enter confirms the text.
      if (
        e.key === 'Enter'
        && !e.shiftKey
        && !e.altKey
        && !e.nativeEvent.isComposing
        && !enterInsertsNewline()
      ) {
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
