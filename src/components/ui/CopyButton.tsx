import { useEffect, useRef, useState } from 'react';
import { IconButton } from './IconButton';

function ClipboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export interface CopyButtonProps {
  text: string;
  /** Accessible name and tooltip. */
  label?: string;
  /**
   * Class on the wrapping span, for placement (e.g. reveal on hover). The
   * wrapper carries `data-copied` for a moment after a copy.
   */
  className?: string;
}

/** Copies text to the clipboard; shows a checkmark for a moment after. */
export function CopyButton({ text, label = 'Copy', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span className={className} data-copied={copied || undefined}>
      <IconButton
        label={copied ? 'Copied' : label}
        size="compactIcon"
        onPress={() => {
          navigator.clipboard?.writeText(text);
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </IconButton>
    </span>
  );
}
