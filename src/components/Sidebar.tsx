import { useState } from 'react';
import { Conversation } from '../types';
import { vaultService } from '../services/vault';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Menu } from '@tauri-apps/api/menu';
import './Sidebar.css';

interface SidebarProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onNewComparison: () => void;
  onRenameConversation: (oldId: string, newTitle: string) => void;
  onDeleteConversation: (id: string) => void;
}

export function Sidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onNewComparison,
  onRenameConversation,
  onDeleteConversation,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleContextMenu = async (e: React.MouseEvent, conversationId: string) => {
    e.preventDefault();

    const filePath = await vaultService.getConversationFilePath(conversationId);
    if (!filePath) return;

    try {
      const menu = await Menu.new({
        items: [
          {
            id: 'rename',
            text: 'Rename',
            action: () => {
              startRename(conversationId);
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
        ]
      });

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
        <input
          type="text"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
        <button onClick={handleFabClick} className="new-button" title="New">
          +
        </button>
      </div>

      <div className="conversations-list">
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
              className={`conversation-item ${
                conversation.id === currentConversationId ? 'active' : ''
              }${conversation.comparison ? ' comparison' : ''}`}
              onClick={() => onSelectConversation(conversation.id)}
              onContextMenu={(e) => handleContextMenu(e, conversation.id)}
            >
              <div className="conversation-preview">
                {conversation.comparison && <span className="comparison-badge">Compare</span>}
                {getConversationTitle(conversation)}
              </div>
              <div className="conversation-meta">
                <span className="conversation-date">{formatDate(conversation.created)}</span>
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
    </div>
  );
}
