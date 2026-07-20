import React from 'react';
import { Components } from 'react-markdown';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DiagramBlock } from '../components/DiagramBlock';
import { CodeBlock } from '../components/CodeBlock';
import type { ConversationInfo } from '../types';

// Flatten a react-markdown code block's children back to raw source text.
// Children may be a plain string (unhighlighted languages like mermaid) or
// nested React <span> elements (when rehype-highlight highlighted the block,
// e.g. svg via the xml alias). Walking the tree recovers the original source.
function extractCodeText(children: React.ReactNode): string {
  if (children == null || children === false || children === true) return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractCodeText).join('');
  if (React.isValidElement(children)) {
    return extractCodeText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
}

// Helper to extract conversation ID from a path
// Format: conversations/YYYY-MM-DD-HHMM-hash-title -> YYYY-MM-DD-HHMM-hash
export function extractConversationId(path: string): string {
  const withoutPrefix = path.replace('conversations/', '');
  return withoutPrefix.split('-').slice(0, 5).join('-');
}

// Extract a display name from a conversation path
// e.g., "conversations/2025-01-19-1430-a1b2-my-topic" -> "my-topic" or the full path if no title
function extractDisplayName(path: string): string {
  const withoutPrefix = path.replace('conversations/', '');
  // Strip ^messageId suffix if present (provenance markers include message refs)
  const withoutMessageId = withoutPrefix.split('^')[0];
  // Remove the ID prefix (YYYY-MM-DD-HHMM-hash-) to get the title slug
  const titleSlug = withoutMessageId.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]+-?/, '');
  // Convert slug back to readable text (replace hyphens with spaces, capitalize)
  if (titleSlug) {
    return titleSlug.replace(/-/g, ' ');
  }
  return '↗'; // Fallback if no title
}

// Convert [[wiki-links]] and &[[provenance]] to markdown links with special protocols
// Supports: [[note-name]], [[conversations/id-title]], &[[conversations/id-title]]
export function processWikiLinks(content: string): string {
  // First, handle &[[...]] provenance markers
  // Format: &[[convId^msgId]] or &[[convId^msgId|Label]]
  let result = content.replace(/&\[\[([^\]]+)\]\]/g, (match, linkTarget) => {
    // Split off optional |label suffix (use label as display name if present)
    const pipeIndex = linkTarget.indexOf('|');
    const label = pipeIndex >= 0 ? linkTarget.slice(pipeIndex + 1) : null;
    const target = pipeIndex >= 0 ? linkTarget.slice(0, pipeIndex) : linkTarget;
    const displayName = label || extractDisplayName(target);
    console.log('[processWikiLinks] Found provenance marker:', { match, linkTarget, displayName });
    // URL-encode the full linkTarget (including |label) to preserve it for the click handler
    return `[${displayName}](provenance:${encodeURIComponent(linkTarget)})`;
  });

  // Then handle regular [[...]] wiki-links
  result = result.replace(/\[\[([^\]]+)\]\]/g, (_match, linkTarget) => {
    // Determine if it's a conversation link or note link
    const isConversation = linkTarget.startsWith('conversations/');
    const displayName = isConversation
      ? linkTarget.replace('conversations/', '').replace(/^\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]+-?/, '')
      : linkTarget;
    // URL-encode the target to handle spaces and special characters in markdown links
    return `[${displayName || linkTarget}](wikilink:${encodeURIComponent(linkTarget)})`;
  });

  return result;
}

interface WikiLinkCallbacks {
  onNavigateToNote?: (noteFilename: string) => void;
  onNavigateToConversation?: (conversationId: string, messageId?: string) => void;
  conversations?: ConversationInfo[]; // For looking up conversation titles
}

// Look up conversation title from conversations array
function lookupConversationTitle(conversationId: string, conversations?: ConversationInfo[]): string | null {
  if (!conversations) return null;
  const conv = conversations.find(c => c.id === conversationId);
  return conv?.title || null;
}

// Create markdown components with wiki-link handling
export function createMarkdownComponents(callbacks: WikiLinkCallbacks): Components {
  const { onNavigateToNote, onNavigateToConversation, conversations } = callbacks;

  return {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      // Handle provenance markers (&[[...]]) - these link to conversations/riff with optional message ID
      // Format: &[[conversationPath^messageId]] or &[[conversationPath^messageId|Label]]
      if (href?.startsWith('provenance:')) {
        const rawTarget = decodeURIComponent(href.replace('provenance:', ''));
        // Strip optional |label suffix
        const pipeIndex = rawTarget.indexOf('|');
        const label = pipeIndex >= 0 ? rawTarget.slice(pipeIndex + 1) : null;
        const target = pipeIndex >= 0 ? rawTarget.slice(0, pipeIndex) : rawTarget;
        // Parse conversation path and optional message ID (separated by ^)
        const [conversationPath, messageId] = target.split('^');
        const conversationId = conversationPath === 'riff_history'
          ? 'riff_history'
          : extractConversationId(conversationPath);
        // Use embedded label first, then look up conversation title, fall back to slug-derived name
        const conversationTitle = label
          || (conversationId === 'riff_history' ? 'Note Chat' : null)
          || lookupConversationTitle(conversationId, conversations);
        const displayText = conversationTitle || children;

        return React.createElement('a', {
          href: '#',
          className: 'provenance-link',
          title: conversationTitle ? `View: ${conversationTitle}` : 'View source conversation',
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (onNavigateToConversation) {
              onNavigateToConversation(conversationId, messageId);
            }
          }
        }, displayText);
      }

      // Handle wiki-links
      if (href?.startsWith('wikilink:')) {
        const target = decodeURIComponent(href.replace('wikilink:', ''));
        const isConversation = target.startsWith('conversations/');

        return React.createElement('a', {
          href: '#',
          className: 'wiki-link',
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (isConversation) {
              const conversationId = extractConversationId(target);
              if (onNavigateToConversation) {
                onNavigateToConversation(conversationId);
              }
            } else {
              // It's a note link - add .md extension if not present
              const noteFilename = target.endsWith('.md') ? target : `${target}.md`;
              if (onNavigateToNote) {
                onNavigateToNote(noteFilename);
              }
            }
          }
        }, children);
      }

      // Handle regular external links
      return React.createElement('a', {
        href: href,
        onClick: (e: React.MouseEvent) => {
          e.preventDefault();
          if (href) {
            openUrl(href);
          }
        },
        onAuxClick: (e: React.MouseEvent) => {
          e.preventDefault();
          if (href) {
            openUrl(href);
          }
        }
      }, children);
    },
    img: ({ src, alt, ...props }: { src?: string; alt?: string; [key: string]: any }) => {
      if (!src) return null;
      return React.createElement('img', { src, alt, ...props });
    },
    // Inline code passes through; fenced blocks are handled by `pre` below (a
    // fenced block is a `code` element wrapped in `pre`).
    code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode; [key: string]: any }) => {
      return React.createElement('code', { className, ...props }, children);
    },
    // Fenced blocks: mermaid/svg show source by default with an optional render
    // view; every other block gets its own copy action. The child is the
    // (already syntax-highlighted) `code` element; extractCodeText recovers raw
    // source for copying / diagram input even when it's wrapped in spans.
    pre: ({ children }: { children?: React.ReactNode; [key: string]: any }) => {
      const codeEl = Array.isArray(children)
        ? children.find((c) => React.isValidElement(c))
        : children;
      if (!React.isValidElement(codeEl)) {
        return React.createElement('pre', {}, children);
      }
      const codeProps = codeEl.props as { className?: string; children?: React.ReactNode };
      const language = codeProps.className?.match(/language-(\w+)/)?.[1];
      const code = extractCodeText(codeProps.children).replace(/\n$/, '');
      if (language === 'mermaid') {
        return React.createElement(DiagramBlock, { kind: 'mermaid', code, children: codeEl });
      }
      if (language === 'svg') {
        return React.createElement(DiagramBlock, { kind: 'svg', code, children: codeEl });
      }
      return React.createElement(CodeBlock, { code, children: codeEl });
    },
  };
}
