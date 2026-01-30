import { useEffect, useCallback, RefObject } from 'react';

interface UseScrollToMessageOptions {
  containerRef: RefObject<HTMLElement | null>;
  messageId: string | null | undefined;
  onScrollComplete?: () => void;
}

/**
 * Hook for scrolling to a specific message by ID within a container.
 * Messages should have data-message-id attributes.
 * Adds a brief highlight effect after scrolling.
 */
export function useScrollToMessage({
  containerRef,
  messageId,
  onScrollComplete,
}: UseScrollToMessageOptions) {
  useEffect(() => {
    if (!messageId || !containerRef.current) return;

    // Wait for DOM to update
    requestAnimationFrame(() => {
      const element = containerRef.current?.querySelector(`[data-message-id="${messageId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Briefly highlight the message
        element.classList.add('message-highlight');
        setTimeout(() => element.classList.remove('message-highlight'), 2000);
      }
      onScrollComplete?.();
    });
  }, [messageId, onScrollComplete, containerRef]);
}

/**
 * Returns a function to scroll to a specific message by ID.
 * Useful for imperative scrolling (e.g., via ref handle).
 */
export function useScrollToMessageCallback(containerRef: RefObject<HTMLElement | null>) {
  return useCallback((messageId: string) => {
    if (!containerRef.current) return;

    const element = containerRef.current.querySelector(`[data-message-id="${messageId}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Briefly highlight the message
      element.classList.add('message-highlight');
      setTimeout(() => element.classList.remove('message-highlight'), 2000);
    }
  }, [containerRef]);
}
