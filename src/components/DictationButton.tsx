import { useRef } from 'react';
import type { DictationState } from '../hooks/useDictation';
import { useAudioLevel } from '../hooks/useAudioLevel';
import { Button, type ButtonProps } from './ui/Button';
import styles from './DictationButton.module.css';

interface DictationButtonProps extends Omit<ButtonProps, 'children' | 'variant' | 'size'> {
  dictationState: DictationState;
  /** Live microphone stream while recording, driving the level meter. */
  stream?: MediaStream | null;
}

/**
 * Shared microphone control used by Riff and conversation composers. While
 * recording it shows a live level meter (red, pulsing) rather than a stop
 * square or a second mic, so it can't be mistaken for "stop generating"
 * beside it or for the idle mic, and shows the mic is actually hearing you.
 */
export function DictationButton({ dictationState, stream, ...props }: DictationButtonProps) {
  const isActive = dictationState !== 'idle';
  const buttonRef = useRef<HTMLButtonElement>(null);
  useAudioLevel(isActive ? stream : null, buttonRef);

  return (
    <Button
      type="button"
      variant="secondary"
      size="composer"
      data-composer-control="mic"
      data-recording={isActive || undefined}
      data-dictation-state={dictationState}
      ref={buttonRef}
      {...props}
    >
      {isActive ? (
        <span className={styles.bars} aria-hidden="true">
          <span /><span /><span /><span />
        </span>
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
