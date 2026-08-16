import { RefObject, useEffect } from 'react';

/**
 * Grow a textarea to fit its content, up to the CSS max-height.
 *
 * Recomputes on viewport changes as well as on edits: the height is written
 * inline from `scrollHeight`, so a value measured in one layout survives into
 * another. Rotating a phone changes the composer's width — and therefore how
 * the text wraps — without changing `value`, which used to leave a tall box
 * from the previous orientation stuck on screen, empty.
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;

    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    };

    resize();

    // Rotation settles asynchronously, so measure again once the new layout
    // exists rather than while it is still changing.
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };

    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);
    // The software keyboard changes the visual viewport without firing a window
    // resize on iOS.
    window.visualViewport?.addEventListener('resize', remeasure);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('orientationchange', remeasure);
      window.visualViewport?.removeEventListener('resize', remeasure);
    };
  }, [ref, value]);
}
