import type { DictationState } from '../hooks/useDictation';
import { Button, type ButtonProps } from './ui/Button';

interface DictationButtonProps extends Omit<ButtonProps, 'children' | 'variant' | 'size'> {
  dictationState: DictationState;
}

/**
 * Shared microphone control used by Riff and conversation composers. While
 * recording it stays a microphone (filled, red, pulsing) rather than a stop
 * square, so it can't be mistaken for "stop generating" sitting beside it.
 */
export function DictationButton({ dictationState, ...props }: DictationButtonProps) {
  const isActive = dictationState !== 'idle';

  return (
    <Button
      type="button"
      variant="secondary"
      size="composer"
      data-composer-control="mic"
      data-recording={isActive || undefined}
      data-dictation-state={dictationState}
      {...props}
    >
      {isActive ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="1" width="6" height="13" rx="3" fill="currentColor" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="1" width="6" height="13" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </svg>
      )}
    </Button>
  );
}
