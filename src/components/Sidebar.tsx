import { useState, useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { ModelInfo, TimelineItem, TimelineFilter } from '../types';
import { vaultService } from '../services/vault';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { openInEditor, type ExternalEditor } from '../utils/openInEditor';
import { Menu } from '@tauri-apps/api/menu';
import { useTaskContext } from '../contexts/TaskContext';
import { useWindowedList } from '../hooks/useWindowedList';
import { useComposerDraftIds } from '../services/composerDrafts';
import { isTauri } from '../services/api';
import { splitOnMatches } from '../utils/findMatches';
import { useVaultSearch, vaultSearchHitKey } from '../hooks/useVaultSearch';
import { useTextareaProps } from '../utils/textareaProps';
import { isLocalModel, modelDisplayName } from '../utils/models';
import { useRunningTaskIds } from '../hooks/useRunningTaskIds';
import { useProviderLocalities } from '../contexts/ProviderLocalityContext';
import { AlloyDialog, Badge, Button, DialogActions, DialogBody, IconButton, LockIcon, NoteIcon, SearchField, SegmentedControl, TaskIcon, TextField } from './ui';
import { HeaderActions } from './HeaderActions';
import { TitleSuggestions } from './TitleSuggestions';
import './Sidebar.css';

interface SidebarSearchControlProps {
  onQueryChange: (query: string) => void;
  showLogo: boolean;
  filtersOpen: boolean;
  filterActive: boolean;
  onToggleFilters: () => void;
}

/**
 * Keep the live controlled value out of Sidebar itself. The sidebar can render
 * thousands of timeline rows; storing each keystroke in that parent caused all
 * of them to be reconciled before the search debounce had even expired.
 */
const SidebarSearchControl = forwardRef<HTMLInputElement, SidebarSearchControlProps>(
  function SidebarSearchControl({
    onQueryChange,
    showLogo,
    filtersOpen,
    filterActive,
    onToggleFilters,
  }, ref) {
    const textareaProps = useTextareaProps();
    const [value, setValue] = useState('');
    // SearchField doesn't forward a ref to its input; find it for focusSearch.
    const wrapperRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => wrapperRef.current!.querySelector('input')!);

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
        {showLogo && (
          <img src="/icon-192.png" alt="Alloy" className="sidebar-app-icon" width="32" height="32" />
        )}
        <div className="search-input-wrapper" ref={wrapperRef}>
          <SearchField
            aria-label="Search"
            placeholder="Search..."
            value={value}
            onChange={setValue}
            onClear={clear}
            {...textareaProps}
            spellCheck={String(textareaProps.spellCheck)}
          />
        </div>
        <span className={`filter-toggle ${filtersOpen ? 'open' : ''} ${filterActive ? 'active' : ''}`}>
          <Button
            variant="quiet"
            size="icon"
            onPress={onToggleFilters}
            aria-label={filterActive ? 'Filter by type (filtered)' : 'Filter by type'}
            aria-expanded={filtersOpen}
            aria-controls="timeline-filters"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 6h18M7 12h10M10 18h4" />
            </svg>
          </Button>
        </span>
      </div>
    );
  },
);

function latestTaskError(item: TimelineItem): string | null {
  const attempt = item.type === 'task' ? item.task?.history?.[0] : undefined;
  if (attempt?.result !== 'error') return null;
  return attempt.error?.trim() || attempt.reasoning?.trim() || 'Task execution failed';
}

/**
 * Above this many rows the list is windowed. Below it, every row stays in the
 * DOM exactly as before — short lists were never slow, and the reorder
 * animation needs the rows it animates to be present.
 */
const WINDOW_THRESHOLD = 80;

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
  onRenameConversation: (oldId: string, newTitle: string) => void;
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
  onRenameConversation,
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const providerLocalities = useProviderLocalities();
  const [deletingItem, setDeletingItem] = useState<{ type: 'conversation' | 'note' | 'task'; id: string } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Client-side filtering can only see timeline metadata. The hook scans note
  // and conversation bodies server-side, retains snippets for display,
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

  const startRename = (id: string) => {
    const item = timelineItems.find(i => i.id === id && i.type === 'conversation');
    if (!item) return;
    setRenamingId(id);
    setRenameValue(item.conversation?.title || 'New conversation');
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

  const confirmDelete = async () => {
    if (deletingItem) {
      if (deletingItem.type === 'conversation') {
        onDeleteConversation(deletingItem.id);
      } else if (deletingItem.type === 'task') {
        onDeleteTask(deletingItem.id);
      } else if (deletingItem.type === 'note') {
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
    } else if (item.type === 'note') {
      filePath = await vaultService.getNoteFilePath(item.id);
    }

    if (!filePath) return;

    try {
      const menuItems = [];

      if (item.type === 'conversation') {
        menuItems.push({
          id: 'rename',
          text: 'Rename',
          action: () => {
            startRename(item.id);
          }
        });
      }

      // Opening a file in Obsidian or the default app needs the Mac that holds
      // the vault; a phone would be handed a Mac path it can't open.
      if (!fullScreen) {
        menuItems.push({
          id: 'edit',
          text: externalEditor === 'obsidian' && filePath.endsWith('.md')
            ? 'Open in Obsidian'
            : 'Open in default app',
          action: async () => {
            try {
              await openInEditor(filePath, externalEditor);
            } catch (error) {
              console.error('Failed to open file in editor:', error);
            }
          }
        });
      }

      // Reveal acts on a path on the machine running Alloy, so it only works
      // in the desktop app; a browser or phone has no Finder to open.
      if (isTauri()) {
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
      }

      menuItems.push({
        id: 'delete',
        text: 'Delete',
        danger: true,
        separatorBefore: menuItems.length > 0,
        action: () => {
          setDeletingItem({ type: item.type, id: item.id });
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

  const getModelDisplayName = (modelString: string) => modelDisplayName(modelString, availableModels);

  const isLocalConversation = (item: TimelineItem) =>
    item.type === 'conversation' && !!item.conversation && isLocalModel(item.conversation.model, providerLocalities, availableModels);

  // Filter items by type and search query
  const timelineTasks = useMemo(
    () => timelineItems.flatMap(item => (item.type === 'task' && item.task ? [item.task] : [])),
    [timelineItems],
  );
  const runningTaskIds = useRunningTaskIds(timelineTasks);

  const filteredItems = useMemo(() => {
    return timelineItems.filter(item => {
      // Apply type filter
      if (activeFilter !== 'all') {
        if (activeFilter === 'conversations' && item.type !== 'conversation') return false;
        if (activeFilter === 'notes' && item.type !== 'note') return false;
        if (activeFilter === 'tasks' && item.type !== 'task') return false;
      }

      // Apply search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = item.title.toLowerCase().includes(query);
        const matchesId = item.id.toLowerCase().includes(query);
        const matchesPreview = item.preview?.toLowerCase().includes(query);
        // Note bodies are no longer shipped to the client; /api/search covers
        // them (see serverMatchIds below). memory.md still carries its content,
        // so keep matching whatever content is present.
        const matchesContent = item.note?.content?.toLowerCase().includes(query);

        // For conversations, also search message content
        if (item.type === 'conversation' && item.conversation) {
          const hasMatchingMessage = item.conversation.messages.some(
            msg => msg.content.toLowerCase().includes(query)
          );
          if (hasMatchingMessage) return true;
        }

        // Server-side full-text hit (conversation transcripts, note bodies).
        if (item.type !== 'task' && serverMatches.has(vaultSearchHitKey(item.type, item.id))) return true;

        if (!matchesTitle && !matchesId && !matchesPreview && !matchesContent) return false;
      }

      return true;
    });
    // serverMatches arrives asynchronously after the query is set, so it must
    // be a dependency — otherwise the list keeps the pre-search result.
  }, [timelineItems, activeFilter, searchQuery, serverMatches]);

  const draftIds = useComposerDraftIds();

  // Render only the visible slice once the list gets long.
  const windowingEnabled = filteredItems.length > WINDOW_THRESHOLD;
  const { startIndex, endIndex, topPadding, bottomPadding } = useWindowedList({
    containerRef,
    itemCount: filteredItems.length,
    enabled: windowingEnabled,
  });
  const visibleItems = useMemo(
    () => (windowingEnabled ? filteredItems.slice(startIndex, endIndex) : filteredItems),
    [filteredItems, windowingEnabled, startIndex, endIndex],
  );

  const renderSearchSnippet = (item: TimelineItem) => {
    if (!searchQuery.trim() || item.type === 'task') return null;
    const match = serverMatches.get(vaultSearchHitKey(item.type, item.id));
    return match ? <div className="item-search-snippet">{highlightMatches(match.snippet)}</div> : null;
  };

  const highlightMatches = (text: string) =>
    splitOnMatches(text, searchQuery).map((segment, i) =>
      segment.match ? <mark key={i} className="search-match">{segment.text}</mark> : segment.text,
    );

  const getTypeBadge = (item: TimelineItem) => {
    switch (item.type) {
      case 'conversation':
        return isLocalConversation(item)
          ? <Badge icon={<LockIcon />} title="Uses a local model">Local</Badge>
          : null;
      case 'note':
        return <Badge tone="accent" icon={<NoteIcon />}>Note</Badge>;
      case 'task':
        return (
          <>
            <Badge tone="success" icon={<TaskIcon />}>Task</Badge>
            {item.task && !item.task.enabled && (
              <Badge tone="warning" title="Paused — will not run on its schedule">Paused</Badge>
            )}
            {item.task && isLocalModel(item.task.model, providerLocalities, availableModels) && (
              <Badge icon={<LockIcon />} title="Uses a local model">Local</Badge>
            )}
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className={`sidebar ${fullScreen ? 'full-screen' : ''}`}>
      {!fullScreen && <div className="window-drag-strip" data-tauri-drag-region />}
      {fullScreen && onMobileBack && (
        <div className="mobile-sidebar-header">
          <img src="/icon-192.png" alt="Alloy" className="mobile-app-icon" width="28" height="28" />
          <h2>Alloy</h2>
          <HeaderActions />
        </div>
      )}
      <SidebarSearchControl
        ref={searchInputRef}
        onQueryChange={setSearchQuery}
        showLogo={!fullScreen}
        filtersOpen={filtersOpen}
        filterActive={activeFilter !== 'all'}
        onToggleFilters={() => setFiltersOpen(open => !open)}
      />

      {/* Hidden until asked for, to give the list more room. The toggle turns
          accent-coloured while a filter other than All is applied. */}
      <div className="filter-tabs-container" id="timeline-filters" hidden={!filtersOpen}>
        <SegmentedControl
          aria-label="Filter timeline by type"
          value={activeFilter}
          onChange={(value) => onFilterChange(value as TimelineFilter)}
          options={[
            { id: 'all', label: 'All' },
            { id: 'conversations', label: 'Chats' },
            { id: 'notes', label: 'Notes' },
            { id: 'tasks', label: 'Tasks' },
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
          <>
          {topPadding > 0 && <div style={{ height: topPadding }} aria-hidden="true" />}
          {visibleItems.map((item) => (
            <div
              key={item.id}
              data-item-id={item.id}
              className={`timeline-item ${item.type} ${
                item.id === selectedItemId ? 'active' : ''
              }${streamingConversationIds.includes(item.id) ? ' streaming' : ''}${
                latestTaskError(item) && !runningTaskIds.has(item.id) ? ' task-failed' : ''
              }`}
              onClick={() => handleSelectItem(item)}
              onContextMenu={(e) => handleContextMenu(e, item)}
            >
              <span className="item-menu-btn">
                <IconButton
                  label="More actions"
                  size="compactIcon"
                  onPress={() => void openItemMenu(item)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                </IconButton>
              </span>
              <div className="item-preview">
                <span className="item-title">
                  {highlightMatches(item.title)}
                </span>
              </div>
              {renderSearchSnippet(item)}
              <div className="item-meta">
                {/* Badges ride on the meta line so the title always gets the
                    full row width. */}
                <span className="item-meta-start">
                  {/* On the meta line, not the title's, so the title doesn't
                      shift or rewrap as these come and go. */}
                  {/* One status at a time, most urgent first. A run in
                      progress outranks the previous run's failure. */}
                  {runningTaskIds.has(item.id) ? (
                    <span className="streaming-indicator" role="img" aria-label="Task running" title="Running…">●</span>
                  ) : latestTaskError(item) ? (
                    <span
                      className="task-error-indicator"
                      role="img"
                      aria-label="Latest task run failed"
                      title={latestTaskError(item) ?? undefined}
                    >!</span>
                  ) : streamingConversationIds.includes(item.id) ? (
                    <span className="streaming-indicator" title="Streaming...">●</span>
                  ) : unreadConversationIds.includes(item.id) || deliveredTaskIds.includes(item.id) ? (
                    <span className="unread-indicator" title={deliveredTaskIds.includes(item.id) ? "Task result delivered" : "New response"}>●</span>
                  ) : item.type === 'conversation' && draftIds.has(item.id) ? (
                    <span className="draft-indicator" role="img" aria-label="Unsent draft" title="Unsent draft">○</span>
                  ) : null}
                  <span className="item-date">{formatDate(item.lastUpdated)}</span>
                  {getTypeBadge(item)}
                </span>
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
          ))}
          {bottomPadding > 0 && <div style={{ height: bottomPadding }} aria-hidden="true" />}
          </>
        )}
      </div>

      {renamingId && (
        <AlloyDialog
          isOpen
          onOpenChange={(o) => { if (!o) cancelRename(); }}
          size="compact"
          title="Rename conversation"
        >
          {() => (
            <DialogBody>
              <TextField
                aria-label="Conversation title"
                value={renameValue}
                onChange={setRenameValue}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); }}
                autoFocus
                {...textareaProps}
                spellCheck={String(textareaProps.spellCheck)}
              />
              <TitleSuggestions conversationId={renamingId} onPick={setRenameValue} />
              <DialogActions>
                <Button variant="secondary" onPress={cancelRename}>Cancel</Button>
                <Button variant="primary" onPress={confirmRename}>Rename</Button>
              </DialogActions>
            </DialogBody>
          )}
        </AlloyDialog>
      )}

      {deletingItem && (
        <AlloyDialog
          isOpen
          onOpenChange={(o) => { if (!o) cancelDelete(); }}
          size="compact"
          title={`Delete “${timelineItems.find(i => i.id === deletingItem.id && i.type === deletingItem.type)?.title ?? deletingItem.type}”?`}
        >
          {() => (
            <DialogBody>
              <p className="delete-warning">
                This removes the {deletingItem.type === 'conversation' ? 'conversation' : deletingItem.type} from your vault. You can&apos;t undo it.
              </p>
              <DialogActions>
                <Button variant="secondary" onPress={cancelDelete}>Cancel</Button>
                <Button variant="danger" onPress={confirmDelete}>Delete</Button>
              </DialogActions>
            </DialogBody>
          )}
        </AlloyDialog>
      )}

    </div>
  );
});
