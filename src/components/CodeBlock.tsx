import React, { useState } from 'react';
import './CodeBlock.css';

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

/** Icon copy-to-clipboard button; flips to a checkmark briefly after copying. */
export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-icon-btn ${className} ${copied ? 'copied' : ''}`}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? 'Copied' : 'Copy'}
      aria-label="Copy"
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
    </button>
  );
}

interface CodeBlockProps {
  /** Raw source text, used for copying. */
  code: string;
  /** The already-highlighted `<code>` element from react-markdown. */
  children: React.ReactNode;
}

/** A fenced code block with a copy icon in the bottom-right corner. */
export function CodeBlock({ code, children }: CodeBlockProps) {
  return (
    <div className="code-block">
      <pre className="code-block-pre">{children}</pre>
      <CopyButton text={code} className="block-copy" />
    </div>
  );
}
