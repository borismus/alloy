import React from 'react';
import { Components } from 'react-markdown';
import { openUrl } from '@tauri-apps/plugin-opener';

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
  // Remove the ID prefix (YYYY-MM-DD-HHMM-hash-) to get the title slug
  const titleSlug = withoutPrefix.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]+-?/, '');
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
  let result = content.replace(/&\[\[([^\]]+)\]\]/g, (match, linkTarget) => {
    const displayName = extractDisplayName(linkTarget);
    console.log('[processWikiLinks] Found provenance marker:', { match, linkTarget, displayName });
    // URL-encode the target to handle spaces and special characters in markdown links
    return `[${displayName}](provenance:${encodeURIComponent(linkTarget)})`;
  });

  // Then handle regular [[...]] wiki-links
  result = result.replace(/\[\[([^\]]+)\]\]/g, (match, linkTarget) => {
    // Determine if it's a conversation link or note link
    const isConversation = linkTarget.startsWith('conversations/');
    const displayName = isConversation
      ? linkTarget.replace('conversations/', '').replace(/^\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]+-?/, '')
      : linkTarget;
    console.log('[processWikiLinks] Found wiki-link:', { match, linkTarget, displayName, isConversation });
    // URL-encode the target to handle spaces and special characters in markdown links
    return `[${displayName || linkTarget}](wikilink:${encodeURIComponent(linkTarget)})`;
  });

  return result;
}

interface ConversationInfo {
  id: string;
  title?: string;
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
      // Handle provenance markers (&[[...]]) - these link to conversations/ramble with optional message ID
      // Format: &[[conversationPath^messageId]] e.g., &[[ramble_history^msg-a1b2]] or &[[conversations/2025-01-19...^msg-a1b2]]
      if (href?.startsWith('provenance:')) {
        const target = decodeURIComponent(href.replace('provenance:', ''));
        // Parse conversation path and optional message ID (separated by ^)
        const [conversationPath, messageId] = target.split('^');
        const conversationId = conversationPath === 'ramble_history'
          ? 'ramble_history'
          : extractConversationId(conversationPath);
        // Look up the conversation title from YAML, fall back to slug-derived name
        const conversationTitle = conversationId === 'ramble_history'
          ? 'Note Chat'
          : lookupConversationTitle(conversationId, conversations);
        const displayText = conversationTitle || children;

        return React.createElement('a', {
          href: '#',
          className: 'provenance-link',
          title: conversationTitle ? `View: ${conversationTitle}` : 'View source conversation',
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[wikiLinks] Provenance link clicked:', { target, conversationId, messageId, conversationTitle, hasCallback: !!onNavigateToConversation });
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
            console.log('[wikiLinks] Wiki-link clicked:', { target, isConversation, hasNoteCallback: !!onNavigateToNote, hasConvCallback: !!onNavigateToConversation });
            if (isConversation) {
              const conversationId = extractConversationId(target);
              console.log('[wikiLinks] Extracted conversation ID:', conversationId);
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
        }
      }, children);
    },
  };
}
