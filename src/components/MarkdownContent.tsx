import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import type { ConversationInfo } from '../types';
import './MarkdownContent.css';
import 'highlight.js/styles/github.css';

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [rehypeHighlight, rehypeKatex];

// Some models (notably Gemini) emit literal <br> tags. ReactMarkdown escapes raw HTML,
// so these show up as literal text. Replace with a newline outside table rows; inside
// table rows replace with a space so the table structure isn't broken.
function normalizeBrTags(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const replacement = /^\s*\|/.test(line) ? ' ' : '\n';
      return line.replace(/<br\s*\/?>/gi, replacement);
    })
    .join('\n');
}

// Single-dollar inline math (e.g. `$\rightarrow$`) is enabled, but unescaped
// currency like `$5` would otherwise be parsed as a math delimiter. Escape `$`
// when it precedes a digit so remark-math treats it as a literal dollar. Skip
// fenced code blocks and inline code so we don't corrupt code samples.
function escapeCurrencyDollars(content: string): string {
  const escape = (text: string) => text.replace(/(^|[^\\])\$(?=\d)/g, '$1\\$');
  const out: string[] = [];
  let i = 0;
  let buf = '';
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      out.push(escape(buf));
      buf = '';
      const end = content.indexOf('```', i + 3);
      const stop = end === -1 ? content.length : end + 3;
      out.push(content.slice(i, stop));
      i = stop;
      continue;
    }
    if (content[i] === '`') {
      out.push(escape(buf));
      buf = '';
      const end = content.indexOf('`', i + 1);
      const stop = end === -1 ? content.length : end + 1;
      out.push(content.slice(i, stop));
      i = stop;
      continue;
    }
    buf += content[i];
    i++;
  }
  out.push(escape(buf));
  return out.join('');
}

// Allow custom URL protocols (wikilink:, provenance:) in addition to standard ones
function defaultUrlTransform(url: string): string {
  if (url.startsWith('wikilink:') || url.startsWith('provenance:')) {
    return url;
  }
  return url;
}

interface MarkdownContentProps {
  content: string;
  className?: string;
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  urlTransform?: (url: string) => string;
  conversations?: ConversationInfo[];
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = '',
  onNavigateToNote,
  onNavigateToConversation,
  urlTransform = defaultUrlTransform,
  conversations,
}) => {
  const processedContent = useMemo(
    () => processWikiLinks(escapeCurrencyDollars(normalizeBrTags(content))),
    [content]
  );
  const markdownComponents = useMemo(
    () => createMarkdownComponents({ onNavigateToNote, onNavigateToConversation, conversations }),
    [onNavigateToNote, onNavigateToConversation, conversations]
  );

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
        urlTransform={urlTransform}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};
