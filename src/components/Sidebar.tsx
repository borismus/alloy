import { useState, useRef, useLayoutEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { ModelInfo, TimelineItem, TimelineFilter } from '../types';
import { vaultService } from '../services/vault';
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener';
import { Menu } from '@tauri-apps/api/menu';
import { useTriggerContext } from '../contexts/TriggerContext';
import { useTextareaProps } from '../utils/textareaProps';
import './Sidebar.css';

// FLIP animation helper - stores previous positions of items
function useFLIPAnimation(items: TimelineItem[]) {
  const positionsRef = useRef<Map<string, DOMRect>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const prevItemsRef = useRef<string[]>([]);

  // After DOM update, animate from old to new positions
  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const currentIds = items.map(i => i.id);
    const prevIds = prevItemsRef.current;

    // Only animate if the order actually changed (not just content)
    const orderChanged = currentIds.some((id, idx) => prevIds[idx] !== id);

    if (orderChanged && positionsRef.current.size > 0) {
      const elements = containerRef.current.querySelectorAll('[data-item-id]');
      elements.forEach((el) => {
        const id = el.getAttribute('data-item-id');
        if (!id) return;

        const oldRect = positionsRef.current.get(id);
        const newRect = el.getBoundingClientRect();

        if (oldRect) {
          const deltaY = oldRect.top - newRect.top;

          if (Math.abs(deltaY) > 1) {
            (el as HTMLElement).style.transform = `translateY(${deltaY}px)`;
            (el as HTMLElement).style.transition = 'none';

            el.getBoundingClientRect();

            requestAnimationFrame(() => {
              (el as HTMLElement).style.transform = '';
              (el as HTMLElement).style.transition = 'transform 0.3s ease-out';
            });
          }
        }
      });

      const cleanup = setTimeout(() => {
        elements.forEach((el) => {
          (el as HTMLElement).style.transition = '';
        });
      }, 350);

      captureCurrentPositions();
      prevItemsRef.current = currentIds;

      return () => clearTimeout(cleanup);
    }

    captureCurrentPositions();
    prevItemsRef.current = currentIds;
  }, [items]);

  const captureCurrentPositions = () => {
    if (!containerRef.current) return;
    const newPositions = new Map<string, DOMRect>();
    const elements = containerRef.current.querySelectorAll('[data-item-id]');
    elements.forEach((el) => {
      const id = el.getAttribute('data-item-id');
      if (id) {
        newPositions.set(id, el.getBoundingClientRect());
      }
    });
    positionsRef.current = newPositions;
  };

  const capturePositions = () => {
    captureCurrentPositions();
  };

  return { containerRef, capturePositions };
}

interface SidebarProps {
  timelineItems: TimelineItem[];
  activeFilter: TimelineFilter;
  onFilterChange: (filter: TimelineFilter) => void;
  selectedItemId: string | null;
  onSelectItem: (item: TimelineItem) => void;
  streamingConversationIds: string[];
  unreadConversationIds: string[];
  availableModels: ModelInfo[];
  onNewConversation: () => void;
  onNewTrigger: () => void;
  onNewRamble: () => void;
  onRenameConversation: (oldId: string, newTitle: string) => void;
  onRenameRamble: (oldFilename: string, newName: string) => void;
  onDeleteConversation: (id: string) => void;
  onDeleteTrigger: (id: string) => void;
  onDeleteNote: (filename: string) => void;
  // Mobile props
  fullScreen?: boolean;
  onMobileBack?: () => void;
}

export interface SidebarHandle {
  focusSearch: () => void;
}

export const Sidebar = forwardRef<SidebarHandle, SidebarProps>(function Sidebar({
  timelineItems,
  activeFilter,
  onFilterChange,
  selectedItemId,
  onSelectItem,
  streamingConversationIds,
  unreadConversationIds,
  availableModels,
  onNewConversation,
  onNewTrigger,
  onNewRamble,
  onRenameConversation,
  onRenameRamble,
  onDeleteConversation,
  onDeleteTrigger,
  onDeleteNote,
  fullScreen,
  onMobileBack,
}, ref) {
  const textareaProps = useTextareaProps();
  const { firedTriggers, dismissFiredTrigger } = useTriggerContext();
  const firedTriggerIds = firedTriggers.map(f => f.conversationId);
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingType, setRenamingType] = useState<'conversation' | 'ramble' | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingItem, setDeletingItem] = useState<{ type: 'conversation' | 'note' | 'trigger' | 'ramble'; id: string } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  }));

  // FLIP animation for smooth list reordering
  const { containerRef, capturePositions } = useFLIPAnimation(timelineItems);

  const handleSelectItem = (item: TimelineItem) => {
    capturePositions();
    // Dismiss fired trigger indicator when opening
    if (item.type === 'conversation' && firedTriggerIds.includes(item.id)) {
      dismissFiredTrigger(item.id);
    }
    onSelectItem(item);
  };

  const startRename = (id: string, type: 'conversation' | 'ramble') => {
    const item = timelineItems.find(i => i.id === id && i.type === type);
    if (!item) return;

    let currentTitle: string;
    if (type === 'conversation') {
      currentTitle = item.conversation?.title || 'New conversation';
    } else {
      // For rambles, title is the filename without path and extension
      currentTitle = item.title;
    }

    setRenamingId(id);
    setRenamingType(type);
    setRenameValue(currentTitle);
  };

  const confirmRename = () => {
    if (renamingId && renameValue.trim() !== '') {
      if (renamingType === 'conversation') {
        onRenameConversation(renamingId, renameValue.trim());
      } else if (renamingType === 'ramble') {
        onRenameRamble(renamingId, renameValue.trim());
      }
    }
    setRenamingId(null);
    setRenamingType(null);
    setRenameValue('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenamingType(null);
    setRenameValue('');
  };

  const confirmDelete = async () => {
    if (deletingItem) {
      if (deletingItem.type === 'conversation') {
        onDeleteConversation(deletingItem.id);
      } else if (deletingItem.type === 'trigger') {
        onDeleteTrigger(deletingItem.id);
      } else if (deletingItem.type === 'note' || deletingItem.type === 'ramble') {
        onDeleteNote(deletingItem.id);
      }
    }
    setDeletingItem(null);
  };

  const cancelDelete = () => {
    setDeletingItem(null);
  };

  const handleContextMenu = async (e: React.MouseEvent, item: TimelineItem) => {
    e.preventDefault();

    let filePath: string | null = null;

    if (item.type === 'conversation') {
      filePath = await vaultService.getConversationFilePath(item.id);
    } else if (item.type === 'trigger') {
      filePath = await vaultService.getTriggerFilePath(item.id);
    } else if (item.type === 'note' || item.type === 'ramble') {
      filePath = await vaultService.getNoteFilePath(item.id);
    }

    if (!filePath) return;

    try {
      const menuItems = [];

      // Rename is available for conversations and rambles
      if (item.type === 'conversation' || item.type === 'ramble') {
        menuItems.push({
          id: 'rename',
          text: 'Rename',
          action: () => {
            startRename(item.id, item.type as 'conversation' | 'ramble');
          }
        });
      }

      menuItems.push({
        id: 'delete',
        text: 'Delete',
        action: () => {
          setDeletingItem({ type: item.type, id: item.id });
        }
      });

      menuItems.push({
        id: 'reveal',
        text: 'Reveal in Finder',
        action: async () => {
          try {
            await revealItemInDir(filePath);
          } catch (error) {
            console.error('Failed to reveal file in Finder:', error);
          }
        }
      });

      menuItems.push({
        id: 'edit',
        text: 'Edit',
        action: async () => {
          try {
            await openPath(filePath);
          } catch (error) {
            console.error('Failed to open file in editor:', error);
          }
        }
      });

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
            id: 'new-trigger',
            text: 'New Trigger',
            action: () => {
              onNewTrigger();
            }
          },
          {
            id: 'new-ramble',
            text: 'New Ramble',
            action: () => {
              onNewRamble();
            }
          }
        ]
      });

      await menu.popup();
    } catch (error) {
      console.error('Failed to show FAB menu:', error);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (date.toDateString() === now.toDateString()) {
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} min ago`;
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getModelDisplayName = (modelString: string) => {
    const model = availableModels.find(m => m.key === modelString);
    if (model) return model.name;
    const slashIndex = modelString.indexOf('/');
    return slashIndex !== -1 ? modelString.slice(slashIndex + 1) : modelString;
  };

  // Filter items by type and search query
  const filteredItems = useMemo(() => {
    return timelineItems.filter(item => {
      // Apply type filter
      if (activeFilter !== 'all') {
        if (activeFilter === 'conversations' && item.type !== 'conversation') return false;
        if (activeFilter === 'notes' && item.type !== 'note') return false;
        if (activeFilter === 'triggers' && item.type !== 'trigger') return false;
        if (activeFilter === 'rambles' && item.type !== 'ramble') return false;
      }

      // Apply search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = item.title.toLowerCase().includes(query);
        const matchesId = item.id.toLowerCase().includes(query);
        const matchesPreview = item.preview?.toLowerCase().includes(query);

        // For conversations, also search message content
        if (item.type === 'conversation' && item.conversation) {
          const hasMatchingMessage = item.conversation.messages.some(
            msg => msg.content.toLowerCase().includes(query)
          );
          if (hasMatchingMessage) return true;
        }

        if (!matchesTitle && !matchesId && !matchesPreview) return false;
      }

      return true;
    });
  }, [timelineItems, activeFilter, searchQuery]);

  const getTypeBadge = (item: TimelineItem) => {
    switch (item.type) {
      case 'conversation':
        return null;
      case 'note':
        return <span className="type-badge note">Note</span>;
      case 'trigger':
        return <span className="type-badge trigger">Trigger</span>;
      case 'ramble':
        return (
          <span className={`type-badge ramble ${item.note?.isIntegrated ? 'integrated' : 'draft'}`}>
            {item.note?.isIntegrated ? 'Ramble' : 'Draft'}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className={`sidebar ${fullScreen ? 'full-screen' : ''}`}>
      {fullScreen && onMobileBack && (
        <div className="mobile-sidebar-header">
          <button className="mobile-back-button" onClick={onMobileBack}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <h2>Orchestra</h2>
        </div>
      )}
      <div className="search-box" data-tauri-drag-region>
        <div className="search-input-wrapper">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
            {...textareaProps}
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

      <div className="filter-dropdown-container">
        <select
          className="filter-dropdown"
          value={activeFilter}
          onChange={(e) => onFilterChange(e.target.value as TimelineFilter)}
        >
          <option value="all">All</option>
          <option value="conversations">Conversations</option>
          <option value="notes">Notes</option>
          <option value="triggers">Triggers</option>
          <option value="rambles">Rambles</option>
        </select>
      </div>

      <div className="timeline-list" ref={containerRef}>
        {filteredItems.length === 0 && timelineItems.length === 0 ? (
          <div className="no-conversations">
            <p>No items yet</p>
            <p className="hint">Click + to start</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="no-conversations">
            <p>No results found</p>
            <p className="hint">Try a different search or filter</p>
          </div>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              data-item-id={item.id}
              className={`timeline-item ${item.type} ${
                item.id === selectedItemId ? 'active' : ''
              }${streamingConversationIds.includes(item.id) ? ' streaming' : ''}`}
              onClick={() => handleSelectItem(item)}
              onContextMenu={(e) => handleContextMenu(e, item)}
            >
              <div className="item-preview">
                {streamingConversationIds.includes(item.id) && (
                  <span className="streaming-indicator" title="Streaming...">●</span>
                )}
                {!streamingConversationIds.includes(item.id) &&
                 (unreadConversationIds.includes(item.id) || firedTriggerIds.includes(item.id)) && (
                  <span className="unread-indicator" title={firedTriggerIds.includes(item.id) ? "Trigger fired" : "New response"}>●</span>
                )}
                {getTypeBadge(item)}
                {item.title}
              </div>
              <div className="item-meta">
                <span className="item-date">{formatDate(item.lastUpdated)}</span>
                {item.type === 'conversation' && item.conversation && (
                  <span className="item-model" title={item.conversation.model}>
                    {getModelDisplayName(item.conversation.model)}
                  </span>
                )}
                              </div>
            </div>
          ))
        )}
      </div>

      {renamingId && (
        <div className="rename-modal" onClick={cancelRename}>
          <div className="rename-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Rename {renamingType === 'ramble' ? 'Ramble' : 'Conversation'}</h3>
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
              {...textareaProps}
            />
            <div className="rename-buttons">
              <button onClick={cancelRename} className="cancel-button">Cancel</button>
              <button onClick={confirmRename} className="confirm-button">Rename</button>
            </div>
          </div>
        </div>
      )}

      {deletingItem && (
        <div className="rename-modal" onClick={cancelDelete}>
          <div className="rename-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete {deletingItem.type === 'conversation' ? 'Conversation' : deletingItem.type === 'trigger' ? 'Trigger' : deletingItem.type === 'ramble' ? 'Ramble' : 'Note'}</h3>
            <p className="delete-warning">
              Are you sure you want to delete this {deletingItem.type}? This action cannot be undone.
            </p>
            <div className="rename-buttons">
              <button onClick={cancelDelete} className="cancel-button">Cancel</button>
              <button onClick={confirmDelete} className="delete-button">Delete</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
});
