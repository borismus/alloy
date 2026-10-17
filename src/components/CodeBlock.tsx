import React from 'react';
import { CopyButton } from './ui';
import './CodeBlock.css';

interface CodeBlockProps {
  /** Raw source text, used for copying. */
  code: string;
  language?: string;
  /** The already-highlighted `<code>` element from react-markdown. */
  children: React.ReactNode;
}

/** A fenced code block with its language and a block-specific copy action. */
export function CodeBlock({ code, language, children }: CodeBlockProps) {
  return (
    <div className={`code-block ${language ? 'has-language' : ''}`}>
      {language && <span className="code-block-language">{language}</span>}
      <pre className="code-block-pre">{children}</pre>
      <CopyButton text={code} className="block-copy" />
    </div>
  );
}
