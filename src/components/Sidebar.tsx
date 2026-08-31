import { useState, useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Button as AriaButton, MenuTrigger } from 'react-aria-components';
import { ModelInfo, TimelineItem, TimelineFilter } from '../types';
import { vaultService } from '../services/vault';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { openInEditor, type ExternalEditor } from '../utils/openInEditor';
import { Menu } from '@tauri-apps/api/menu';
import { useTaskContext } from '../contexts/TaskContext';
import { useLongPress } from '../hooks/useLongPress';
import { useVaultSearch, vaultSearchHitKey } from '../hooks/useVaultSearch';
import { useTextareaProps } from '../utils/textareaProps';
import { isLocalModel } from '../utils/models';
import { AlloyDialog, AlloyMenu, SegmentedControl } from './ui';
import './Sidebar.css';

interface CreationActionsProps {
  onNewConversation: () => void;
  onNewRiff: () => void;
}

function CreationActions({ onNewConversation, onNewRiff }: CreationActionsProps) {
  return (
    <div className="creation-actions">
      <button
        type="button"
        onClick={onNewConversation}
        className="new-button"
        title="New conversation"
        aria-label="New conversation"
      >
        +
      </button>
      <MenuTrigger>
        <AriaButton
          className="creation-menu-button"
          aria-label="More creation options"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </AriaButton>
        <AlloyMenu
          placement="bottom end"
          items={[{ id: 'new-riff', label: 'New riff' }]}
          onAction={(key) => {
            if (key === 'new-riff') onNewRiff();
          }}
        />
      </MenuTrigger>
    </div>
  );
}

interface SidebarSearchControlProps extends CreationActionsProps {
  onQueryChange: (query: string) => void;
  showCreationActions: boolean;
}

/**
 * Keep the live controlled value out of Sidebar itself. The sidebar can render
 * thousands of timeline rows; storing each keystroke in that parent caused all
 * of them to be reconciled before the search debounce had even expired.
 */
const SidebarSearchControl = forwardRef<HTMLInputElement, SidebarSearchControlProps>(
  function SidebarSearchControl({
    onQueryChange,
    onNewConversation,
    onNewRiff,
    showCreationActions,
  }, ref) {
    const textareaProps = useTextareaProps();
    const [value, setValue] = useState('');

    useEffect(() => {
      if (!value.trim()) {
        onQueryChange('');
        return;
      }
      const timer = window.setTimeout(() => onQueryChange(value), 200);
      return () => window.clearTimeout(timer);
    }, [value, onQueryChange]);

    const clear = () => {
      setValue('');
      // Clearing should restore the timeline immediately rather than waiting
      // for an effect scheduled after this render.
      onQueryChange('');
    };

    return (
      <div className="search-box" data-tauri-drag-region>
        <div className="search-input-wrapper">
          <input
            ref={ref}
            type="text"
            placeholder="Search..."
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="search-input"
            {...textareaProps}
          />
          {value && (
            <button
              onClick={clear}
              className="clear-search-button"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        {showCreationActions && (
          <CreationActions
            onNewConversation={onNewConversation}
            onNewRiff={onNewRiff}
          />
        )}
      </div>
    );
  },
);

function latestTaskError(item: TimelineItem): string | null {
  const attempt = item.type === 'task' ? item.task?.history?.[0] : undefined;
  if (attempt?.result !== 'error') return null;
  return attempt.error?.trim() || attempt.reasoning?.trim() || 'Task execution failed';
}

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
  onNewRiff: () => void;
  onRenameConversation: (oldId: string, newTitle: string) => void;
  onRenameRiff: (oldFilename: string, newName: string) => void;
  onDeleteConversation: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onDeleteNote: (filename: string) => void;
  externalEditor: ExternalEditor;
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
  onNewRiff,
  onRenameConversation,
  onRenameRiff,
  onDeleteConversation,
  onDeleteTask,
  onDeleteNote,
  externalEditor,
  fullScreen,
  onMobileBack,
}, ref) {
  const textareaProps = useTextareaProps();
  const { deliveredResults, dismissDeliveredResult } = useTaskContext();
  const deliveredTaskIds = deliveredResults.map(result => result.taskId);
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingType, setRenamingType] = useState<'conversation' | 'riff' | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingItem, setDeletingItem] = useState<{ type: 'conversation' | 'note' | 'task' | 'riff'; id: string } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Client-side filtering can only see timeline metadata. The hook scans note,
  // riff, and conversation bodies server-side, retains snippets for display,
  // and prevents responses from an older query leaking into a newer one.
  const { matches: serverMatches, loading: searchLoading, error: searchError } = useVaultSearch(searchQuery);
  useEffect(() => {
    if (searchError) {
      console.warn('[Sidebar] vault search failed (falling back to local matching):', searchError);
    }
  }, [searchError]);

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
    // Dismiss the delivered-result indicator when opening its task.
    if (item.type === 'task' && deliveredTaskIds.includes(item.id)) {
      dismissDeliveredResult(item.id);
    }
    onSelectItem(item);
  };

  const startRename = (id: string, type: 'conversation' | 'riff') => {
    const item = timelineItems.find(i => i.id === id && i.type === type);
    if (!item) return;

    let currentTitle: string;
    if (type === 'conversation') {
      currentTitle = item.conversation?.title || 'New conversation';
    } else {
      // For riffs, title is the filename without path and extension
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
      } else if (renamingType === 'riff') {
        onRenameRiff(renamingId, renameValue.trim());
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
      } else if (deletingItem.type === 'task') {
        onDeleteTask(deletingItem.id);
      } else if (deletingItem.type === 'note' || deletingItem.type === 'riff') {
        onDeleteNote(deletingItem.id);
      }
    }
    setDeletingItem(null);
  };

  const cancelDelete = () => {
    setDeletingItem(null);
  };

  const openItemMenu = async (item: TimelineItem) => {
    let filePath: string | null = null;

    if (item.type === 'conversation') {
      filePath = await vaultService.getConversationFilePath(item.id);
    } else if (item.type === 'task') {
      filePath = await vaultService.getTaskFilePath(item.id);
    } else if (item.type === 'note' || item.type === 'riff') {
      filePath = await vaultService.getNoteFilePath(item.id);
    }

    if (!filePath) return;

    try {
      const menuItems = [];

      // Rename is available for conversations and riffs
      if (item.type === 'conversation' || item.type === 'riff') {
        menuItems.push({
          id: 'rename',
          text: 'Rename',
          action: () => {
            startRename(item.id, item.type as 'conversation' | 'riff');
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
            await openInEditor(filePath, externalEditor);
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

  const handleContextMenu = (e: React.MouseEvent, item: TimelineItem) => {
    e.preventDefault();
    void openItemMenu(item);
  };

  // Touch: long-press a row (mobile) opens the same menu right-click does.
  const { getHandlers: getRowLongPress, didLongPress } = useLongPress<TimelineItem>((item) => {
    void openItemMenu(item);
  });

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

  const isLocalConversation = (item: TimelineItem) =>
    item.type === 'conversation' && !!item.conversation && isLocalModel(item.conversation.model, availableModels);

  // Filter items by type and search query
  const filteredItems = useMemo(() => {
    return timelineItems.filter(item => {
      // Apply type filter
      if (activeFilter !== 'all') {
        if (activeFilter === 'conversations' && item.type !== 'conversation') return false;
        if (activeFilter === 'notes' && item.type !== 'note') return false;
        if (activeFilter === 'tasks' && item.type !== 'task') return false;
        if (activeFilter === 'riffs' && item.type !== 'riff') return false;
      }

      // Apply search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = item.title.toLowerCase().includes(query);
        const matchesId = item.id.toLowerCase().includes(query);
        const matchesPreview = item.preview?.toLowerCase().includes(query);
        // Note and riff bodies are no longer shipped to the client; /api/search
        // covers them (see serverMatchIds below). Riffs still carry a small
        // frontmatter snippet, so keep matching whatever content is present.
        const matchesContent = item.note?.content?.toLowerCase().includes(query);

        // For conversations, also search message content
        if (item.type === 'conversation' && item.conversation) {
          const hasMatchingMessage = item.conversation.messages.some(
            msg => msg.content.toLowerCase().includes(query)
          );
          if (hasMatchingMessage) return true;
        }

        // Server-side full-text hit (conversation transcripts, note/riff bodies).
        if (item.type !== 'task' && serverMatches.has(vaultSearchHitKey(item.type, item.id))) return true;

        if (!matchesTitle && !matchesId && !matchesPreview && !matchesContent) return false;
      }

      return true;
    });
    // serverMatches arrives asynchronously after the query is set, so it must
    // be a dependency — otherwise the list keeps the pre-search result.
  }, [timelineItems, activeFilter, searchQuery, serverMatches]);

  const renderSearchSnippet = (item: TimelineItem) => {
    if (!searchQuery.trim() || item.type === 'task') return null;
    const match = serverMatches.get(vaultSearchHitKey(item.type, item.id));
    return match ? <div className="item-search-snippet">{match.snippet}</div> : null;
  };

  const getTypeBadge = (item: TimelineItem) => {
    switch (item.type) {
      case 'conversation':
        return isLocalConversation(item)
          ? <span className="type-badge local" title="Uses a local model">Local</span>
          : null;
      case 'note':
        return <span className="type-badge note">Note</span>;
      case 'task':
        return (
          <>
            <span className="type-badge task">Task</span>
            {item.task && isLocalModel(item.task.model, availableModels) && (
              <span className="type-badge local" title="Uses a local model">Local</span>
            )}
          </>
        );
      case 'riff':
        return (
          <span className={`type-badge riff ${item.note?.isIntegrated ? 'integrated' : 'draft'}`}>
            {item.note?.isIntegrated ? 'Riff' : 'Draft'}
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
          <img src="/icon-192.png" alt="Alloy" className="mobile-app-icon" width="44" height="44" />
          <h2>Alloy</h2>
          <CreationActions
            onNewConversation={onNewConversation}
            onNewRiff={onNewRiff}
          />
        </div>
      )}
      <SidebarSearchControl
        ref={searchInputRef}
        onQueryChange={setSearchQuery}
        onNewConversation={onNewConversation}
        onNewRiff={onNewRiff}
        showCreationActions={!fullScreen}
      />

      <div className="filter-tabs-container">
        <SegmentedControl
          aria-label="Filter timeline by type"
          value={activeFilter}
          onChange={(value) => onFilterChange(value as TimelineFilter)}
          options={[
            { id: 'all', label: 'All' },
            { id: 'conversations', label: 'Chats' },
            { id: 'notes', label: 'Notes' },
            { id: 'tasks', label: 'Tasks' },
            { id: 'riffs', label: 'Riffs' },
          ]}
        />
      </div>

      <div className="timeline-list" ref={containerRef}>
        {filteredItems.length === 0 && timelineItems.length === 0 ? (
          <div className="no-conversations">
            <p>No items yet</p>
            <p className="hint">Click + to start</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="no-conversations">
            <p>{searchLoading ? 'Searching…' : 'No results found'}</p>
            {!searchLoading && <p className="hint">Try a different search or filter</p>}
          </div>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              data-item-id={item.id}
              className={`timeline-item ${item.type} ${
                item.id === selectedItemId ? 'active' : ''
              }${streamingConversationIds.includes(item.id) ? ' streaming' : ''}${
                latestTaskError(item) ? ' task-failed' : ''
              }`}
              onClick={() => {
                // A long-press already opened the menu; don't also select.
                if (didLongPress.current) {
                  didLongPress.current = false;
                  return;
                }
                handleSelectItem(item);
              }}
              onContextMenu={(e) => handleContextMenu(e, item)}
              {...getRowLongPress(item)}
            >
              <button
                type="button"
                className="item-menu-btn"
                aria-label="More actions"
                onClick={(e) => {
                  e.stopPropagation();
                  void openItemMenu(item);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
              <div className="item-preview">
                {streamingConversationIds.includes(item.id) && (
                  <span className="streaming-indicator" title="Streaming...">●</span>
                )}
                {latestTaskError(item) && (
                  <span
                    className="task-error-indicator"
                    role="img"
                    aria-label="Latest task run failed"
                    title={latestTaskError(item) ?? undefined}
                  >!</span>
                )}
                {!streamingConversationIds.includes(item.id) &&
                 !latestTaskError(item) &&
                 (unreadConversationIds.includes(item.id) || deliveredTaskIds.includes(item.id)) && (
                  <span className="unread-indicator" title={deliveredTaskIds.includes(item.id) ? "Task result delivered" : "New response"}>●</span>
                )}
                {getTypeBadge(item)}
                {item.title}
              </div>
              {renderSearchSnippet(item)}
              <div className="item-meta">
                <span className="item-date">{formatDate(item.lastUpdated)}</span>
                {item.type === 'conversation' && item.conversation && (
                  <span className="item-model" title={item.conversation.model}>
                    {getModelDisplayName(item.conversation.model)}
                  </span>
                )}
                {item.type === 'task' && item.task && (
                  <span className="item-model" title={item.task.model}>
                    {getModelDisplayName(item.task.model)}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {renamingId && (
        <AlloyDialog
          isOpen
          onOpenChange={(o) => { if (!o) cancelRename(); }}
          size="compact"
          title={`Rename ${renamingType === 'riff' ? 'Riff' : 'Conversation'}`}
        >
          {() => (
            <div className="dialog-body">
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); }}
                autoFocus
                className="rename-input"
                {...textareaProps}
              />
              <div className="rename-buttons">
                <button onClick={cancelRename} className="cancel-button">Cancel</button>
                <button onClick={confirmRename} className="confirm-button">Rename</button>
              </div>
            </div>
          )}
        </AlloyDialog>
      )}

      {deletingItem && (
        <AlloyDialog
          isOpen
          onOpenChange={(o) => { if (!o) cancelDelete(); }}
          size="compact"
          title={`Delete ${deletingItem.type === 'conversation' ? 'Conversation' : deletingItem.type === 'task' ? 'Task' : deletingItem.type === 'riff' ? 'Riff' : 'Note'}`}
        >
          {() => (
            <div className="dialog-body">
              <p className="delete-warning">
                Are you sure you want to delete this {deletingItem.type}? This action cannot be undone.
              </p>
              <div className="rename-buttons">
                <button onClick={cancelDelete} className="cancel-button">Cancel</button>
                <button onClick={confirmDelete} className="delete-button">Delete</button>
              </div>
            </div>
          )}
        </AlloyDialog>
      )}

    </div>
  );
});
