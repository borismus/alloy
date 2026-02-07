import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { processWikiLinks, createMarkdownComponents } from '../utils/wikiLinks';
import './MarkdownContent.css';
import 'highlight.js/styles/github.css';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

interface ConversationInfo {
  id: string;
  title?: string;
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
  urlTransform,
  conversations,
}) => {
  const processedContent = useMemo(() => processWikiLinks(content), [content]);
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
