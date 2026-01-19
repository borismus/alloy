import { useState, useRef, useLayoutEffect, useImperativeHandle, forwardRef } from 'react';
import { Conversation } from '../types';
import { vaultService } from '../services/vault';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Menu } from '@tauri-apps/api/menu';
import './Sidebar.css';

// FLIP animation helper - stores previous positions of items
function useFLIPAnimation(items: Conversation[]) {
  const positionsRef = useRef<Map<string, DOMRect>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const prevItemsRef = useRef<string[]>([]);

  // Capture positions before render (using the previous items order)
  useLayoutEffect(() => {
    // This runs synchronously after DOM mutations but before paint
    // We need to capture positions BEFORE this effect runs, so we do it
    // at the end of the previous effect cycle
  }, []);

  // After DOM update, animate from old to new positions
  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const currentIds = items.map(i => i.id);
    const prevIds = prevItemsRef.current;

    // Only animate if the order actually changed (not just content)
    const orderChanged = currentIds.some((id, idx) => prevIds[idx] !== id);

    if (orderChanged && positionsRef.current.size > 0) {
      const elements = containerRef.current.querySelectorAll('[data-conversation-id]');
      elements.forEach((el) => {
        const id = el.getAttribute('data-conversation-id');
        if (!id) return;

        const oldRect = positionsRef.current.get(id);
        const newRect = el.getBoundingClientRect();

        if (oldRect) {
          const deltaY = oldRect.top - newRect.top;

          if (Math.abs(deltaY) > 1) {
            // Apply inverse transform to start from old position
            (el as HTMLElement).style.transform = `translateY(${deltaY}px)`;
            (el as HTMLElement).style.transition = 'none';

            // Force reflow
            el.getBoundingClientRect();

            // Animate to new position
            requestAnimationFrame(() => {
              (el as HTMLElement).style.transform = '';
              (el as HTMLElement).style.transition = 'transform 0.3s ease-out';
            });
          }
        }
      });

      // Clean up transitions after animation
      const cleanup = setTimeout(() => {
        elements.forEach((el) => {
          (el as HTMLElement).style.transition = '';
        });
      }, 350);

      // Capture new positions for next animation
      captureCurrentPositions();
      prevItemsRef.current = currentIds;

      return () => clearTimeout(cleanup);
    }

    // Always update positions and prev items after render
    captureCurrentPositions();
    prevItemsRef.current = currentIds;
  }, [items]);

  const captureCurrentPositions = () => {
    if (!containerRef.current) return;
    const newPositions = new Map<string, DOMRect>();
    const elements = containerRef.current.querySelectorAll('[data-conversation-id]');
    elements.forEach((el) => {
      const id = el.getAttribute('data-conversation-id');
      if (id) {
        newPositions.set(id, el.getBoundingClientRect());
      }
    });
    positionsRef.current = newPositions;
  };

  // Capture positions synchronously before state updates
  const capturePositions = () => {
    captureCurrentPositions();
  };

  return { containerRef, capturePositions };
}

interface SidebarProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  streamingConversationIds: string[];
  unreadConversationIds: string[];
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onNewComparison: () => void;
  onRenameConversation: (oldId: string, newTitle: string) => void;
  onDeleteConversation: (id: string) => void;
  onMakeTopic?: (conversationId: string, label: string, prompt: string) => void;
}

export interface SidebarHandle {
  focusSearch: () => void;
}

export const Sidebar = forwardRef<SidebarHandle, SidebarProps>(function Sidebar({
  conversations,
  currentConversationId,
  streamingConversationIds,
  unreadConversationIds,
  onSelectConversation,
  onNewConversation,
  onNewComparison,
  onRenameConversation,
  onDeleteConversation,
  onMakeTopic,
}, ref) {
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [topicDialogId, setTopicDialogId] = useState<string | null>(null);
  const [topicLabel, setTopicLabel] = useState('');
  const [topicPrompt, setTopicPrompt] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  }));

  // FLIP animation for smooth list reordering
  const { containerRef, capturePositions } = useFLIPAnimation(conversations);

  // Capture positions before any state update that might reorder
  const handleSelectConversation = (id: string) => {
    capturePositions();
    onSelectConversation(id);
  };

  const startRename = (conversationId: string) => {
    const conversation = conversations.find(c => c.id === conversationId);
    if (!conversation) return;

    const currentTitle = conversation.title || 'New conversation';
    setRenamingId(conversationId);
    setRenameValue(currentTitle);
  };

  const confirmRename = () => {
    if (renamingId && renameValue.trim() !== '') {
      onRenameConversation(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const confirmDelete = () => {
    if (deletingId) {
      onDeleteConversation(deletingId);
    }
    setDeletingId(null);
  };

  const cancelDelete = () => {
    setDeletingId(null);
  };

  const confirmMakeTopic = () => {
    if (topicDialogId && topicLabel.trim() && topicPrompt.trim() && onMakeTopic) {
      onMakeTopic(topicDialogId, topicLabel.trim(), topicPrompt.trim());
    }
    setTopicDialogId(null);
    setTopicLabel('');
    setTopicPrompt('');
  };

  const cancelMakeTopic = () => {
    setTopicDialogId(null);
    setTopicLabel('');
    setTopicPrompt('');
  };

  const handleContextMenu = async (e: React.MouseEvent, conversationId: string) => {
    e.preventDefault();

    const filePath = await vaultService.getConversationFilePath(conversationId);
    if (!filePath) return;

    try {
      const menuItems = [
        {
          id: 'rename',
          text: 'Rename',
          action: () => {
            startRename(conversationId);
          }
        },
        {
          id: 'make-topic',
          text: 'Make Topic...',
          action: () => {
            const conversation = conversations.find(c => c.id === conversationId);
            // Pre-fill with first user message as suggested prompt
            const firstUserMessage = conversation?.messages.find(m => m.role === 'user');
            setTopicLabel(conversation?.title?.slice(0, 20) || '');
            setTopicPrompt(firstUserMessage?.content || '');
            setTopicDialogId(conversationId);
          }
        },
        {
          id: 'delete',
          text: 'Delete',
          action: () => {
            setDeletingId(conversationId);
          }
        },
        {
          id: 'reveal',
          text: 'Reveal in Finder',
          action: async () => {
            try {
              await revealItemInDir(filePath);
            } catch (error) {
              console.error('Failed to reveal file in Finder:', error);
            }
          }
        }
      ];

      const menu = await Menu.new({ items: menuItems });
      await menu.popup();
    } catch (error) {
      console.error('Failed to show context menu:', error);
    }
  };

  const handleFabClick = async () => {
    try {
      const menu = await Menu.new({
        items: [
          {
            id: 'new-conversation',
            text: 'New Conversation',
            action: () => {
              onNewConversation();
            }
          },
          {
            id: 'new-comparison',
            text: 'New Comparison',
            action: () => {
              onNewComparison();
            }
          }
        ]
      });

      await menu.popup();
    } catch (error) {
      console.error('Failed to show FAB menu:', error);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const getConversationTitle = (conversation: Conversation) => {
    // Use the title if available, otherwise fall back to preview
    if (conversation.title) {
      return conversation.title;
    }
    if (conversation.messages.length === 0) {
      return 'New conversation';
    }
    const firstMessage = conversation.messages[0];
    const preview = firstMessage.content.slice(0, 50);
    const lastSpace = preview.lastIndexOf(' ');
    return lastSpace > 20 ? preview.slice(0, lastSpace) : preview;
  };

  const filteredConversations = conversations.filter((conversation) => {
    if (!searchQuery.trim()) return true;

    const query = searchQuery.toLowerCase();

    // Search in title
    const matchesTitle = conversation.title?.toLowerCase().includes(query);

    // Search in message content
    const hasMatchingMessage = conversation.messages.some((message) =>
      message.content.toLowerCase().includes(query)
    );

    // Search in conversation ID (which includes date)
    const matchesId = conversation.id.toLowerCase().includes(query);

    return matchesTitle || hasMatchingMessage || matchesId;
  });

  return (
    <div className="sidebar">
      <div className="search-box" data-tauri-drag-region>
        <div className="search-input-wrapper">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="clear-search-button"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <button onClick={handleFabClick} className="new-button" title="New">
          +
        </button>
      </div>

      <div className="conversations-list" ref={containerRef}>
        {filteredConversations.length === 0 && conversations.length === 0 ? (
          <div className="no-conversations">
            <p>No conversations yet</p>
            <p className="hint">Click + to start</p>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="no-conversations">
            <p>No results found</p>
            <p className="hint">Try a different search</p>
          </div>
        ) : (
          filteredConversations.map((conversation) => (
            <div
              key={conversation.id}
              data-conversation-id={conversation.id}
              className={`conversation-item ${
                conversation.id === currentConversationId ? 'active' : ''
              }${conversation.comparison ? ' comparison' : ''}${
                streamingConversationIds.includes(conversation.id) ? ' streaming' : ''
              }`}
              onClick={() => handleSelectConversation(conversation.id)}
              onContextMenu={(e) => handleContextMenu(e, conversation.id)}
            >
              <div className="conversation-preview">
                {streamingConversationIds.includes(conversation.id) && (
                  <span className="streaming-indicator" title="Streaming...">●</span>
                )}
                {!streamingConversationIds.includes(conversation.id) && unreadConversationIds.includes(conversation.id) && (
                  <span className="unread-indicator" title="New response">●</span>
                )}
                {conversation.comparison && <span className="comparison-badge">Compare</span>}
                {getConversationTitle(conversation)}
              </div>
              <div className="conversation-meta">
                <span className="conversation-date">{formatDate(conversation.updated || conversation.created)}</span>
                <span className="conversation-count">
                  {conversation.comparison
                    ? `${conversation.comparison.models.length} models`
                    : `${conversation.messages.length} msgs`
                  }
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {renamingId && (
        <div className="rename-modal" onClick={cancelRename}>
          <div className="rename-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Rename Conversation</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  confirmRename();
                } else if (e.key === 'Escape') {
                  cancelRename();
                }
              }}
              autoFocus
              className="rename-input"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <div className="rename-buttons">
              <button onClick={cancelRename} className="cancel-button">Cancel</button>
              <button onClick={confirmRename} className="confirm-button">Rename</button>
            </div>
          </div>
        </div>
      )}

      {deletingId && (
        <div className="rename-modal" onClick={cancelDelete}>
          <div className="rename-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Conversation</h3>
            <p className="delete-warning">Are you sure you want to delete this conversation? This action cannot be undone.</p>
            <div className="rename-buttons">
              <button onClick={cancelDelete} className="cancel-button">Cancel</button>
              <button onClick={confirmDelete} className="delete-button">Delete</button>
            </div>
          </div>
        </div>
      )}

      {topicDialogId && (
        <div className="rename-modal" onClick={cancelMakeTopic}>
          <div className="rename-dialog topic-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Make Topic</h3>
            <p className="topic-hint">Topics appear as pills above your conversations. Clicking a topic re-asks the standing prompt.</p>
            <label className="topic-label">
              Label (short name for the pill)
              <input
                type="text"
                value={topicLabel}
                onChange={(e) => setTopicLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    confirmMakeTopic();
                  } else if (e.key === 'Escape') {
                    cancelMakeTopic();
                  }
                }}
                placeholder="e.g., AI News, SF Trip"
                autoFocus
                className="rename-input"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label className="topic-label">
              Standing prompt (sent when you click the topic)
              <textarea
                value={topicPrompt}
                onChange={(e) => setTopicPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    cancelMakeTopic();
                  }
                }}
                placeholder="e.g., What's new in AI since we last talked?"
                className="topic-prompt-input"
                rows={3}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <div className="rename-buttons">
              <button onClick={cancelMakeTopic} className="cancel-button">Cancel</button>
              <button
                onClick={confirmMakeTopic}
                className="confirm-button"
                disabled={!topicLabel.trim() || !topicPrompt.trim()}
              >
                Create Topic
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
