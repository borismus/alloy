import type { DictationState } from '../hooks/useDictation';
import { Button, type ButtonProps } from './ui/Button';

interface DictationButtonProps extends Omit<ButtonProps, 'children' | 'variant' | 'size'> {
  dictationState: DictationState;
}

/** Shared microphone/stop control used by Riff and conversation composers. */
export function DictationButton({ dictationState, ...props }: DictationButtonProps) {
  const isRecording = dictationState === 'recording';

  return (
    <Button
      type="button"
      variant={isRecording ? 'danger' : 'secondary'}
      size="composer"
      data-composer-control="mic"
      data-recording={isRecording || undefined}
      data-dictation-state={dictationState}
      {...props}
    >
      {isRecording ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2" />
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
