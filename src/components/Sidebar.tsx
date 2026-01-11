import { useState } from 'react';
import { Conversation } from '../types';
import { vaultService } from '../services/vault';
import { Command } from '@tauri-apps/plugin-shell';
import { Menu } from '@tauri-apps/api/menu';
import './Sidebar.css';

interface SidebarProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
}

export function Sidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const handleContextMenu = async (e: React.MouseEvent, conversationId: string) => {
    e.preventDefault();

    const filePath = await vaultService.getConversationFilePath(conversationId);
    if (!filePath) return;

    try {
      const menu = await Menu.new({
        items: [
          {
            id: 'reveal',
            text: 'Reveal in Finder',
            action: async () => {
              try {
                await Command.create('open', ['-R', filePath]).execute();
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
              }`}
              onClick={() => onSelectConversation(conversation.id)}
              onContextMenu={(e) => handleContextMenu(e, conversation.id)}
            >
              <div className="conversation-preview">
                {getConversationTitle(conversation)}
              </div>
              <div className="conversation-meta">
                <span className="conversation-date">{formatDate(conversation.created)}</span>
                <span className="conversation-count">{conversation.messages.length} msgs</span>
              </div>
            </div>
          ))
        )}
      </div>

      <button onClick={onNewConversation} className="fab" title="New Conversation">
        +
      </button>
    </div>
  );
}
