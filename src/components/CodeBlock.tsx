import React, { useState } from 'react';
import './CodeBlock.css';

/** A small copy-to-clipboard button that flips to "Copied" briefly. */
export function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copied' : ''}`}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      title={title}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

interface CodeBlockProps {
  /** Raw source text, used for copying. */
  code: string;
  language?: string;
  /** The already-highlighted `<code>` element from react-markdown. */
  children: React.ReactNode;
}

/** A fenced code block with a language label and a copy button. */
export function CodeBlock({ code, language, children }: CodeBlockProps) {
  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span className="code-block-lang">{language || 'text'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-block-pre">{children}</pre>
    </div>
  );
}
