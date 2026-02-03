import { useState, useRef, useLayoutEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Conversation, ModelInfo, NoteInfo, SidebarTab, Trigger } from '../types';
import { vaultService } from '../services/vault';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Menu } from '@tauri-apps/api/menu';
import { useTriggerContext } from '../contexts/TriggerContext';
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
  triggers: Trigger[];
  currentConversationId: string | null;
  streamingConversationIds: string[];
  unreadConversationIds: string[];
  availableModels: ModelInfo[];
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onNewComparison: () => void;
  onNewCouncil: () => void;
  onNewTrigger: () => void;
  onRenameConversation: (oldId: string, newTitle: string) => void;
  onDeleteConversation: (id: string) => void;
  onDeleteTrigger: (id: string) => void;
  onOpenTriggerManagement: () => void;
  // Notes tab props
  notes: NoteInfo[];
  activeTab: SidebarTab;
  selectedNoteFilename: string | null;
  onSelectNote: (filename: string) => void;
  onNewNotesChat: () => void;
  onTabChange: (tab: SidebarTab) => void;
  // Navigation
  canGoBack: boolean;
  onGoBack: () => void;
  // Mobile props
  fullScreen?: boolean;
  onMobileBack?: () => void;
}

export interface SidebarHandle {
  focusSearch: () => void;
}

export const Sidebar = forwardRef<SidebarHandle, SidebarProps>(function Sidebar({
  conversations,
  triggers,
  currentConversationId,
  streamingConversationIds,
  unreadConversationIds,
  availableModels,
  onSelectConversation,
  onNewConversation,
  onNewComparison,
  onNewCouncil,
  onNewTrigger,
  onRenameConversation,
  onDeleteConversation,
  onDeleteTrigger,
  onOpenTriggerManagement,
  notes,
  activeTab,
  selectedNoteFilename,
  onSelectNote,
  onNewNotesChat: _onNewNotesChat,
  onTabChange,
  canGoBack,
  onGoBack,
  fullScreen,
  onMobileBack,
}, ref) {
  const { firedTriggers, dismissFiredTrigger } = useTriggerContext();
  const firedTriggerIds = firedTriggers.map(f => f.conversationId);
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingItem, setDeletingItem] = useState<{ type: 'conversation' | 'note' | 'trigger'; id: string } | null>(null);
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
    // Dismiss fired trigger indicator when opening the conversation
    if (firedTriggerIds.includes(id)) {
      dismissFiredTrigger(id);
    }
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

  const confirmDelete = async () => {
    if (deletingItem) {
      if (deletingItem.type === 'conversation') {
        onDeleteConversation(deletingItem.id);
      } else if (deletingItem.type === 'trigger') {
        onDeleteTrigger(deletingItem.id);
      } else if (deletingItem.type === 'note') {
        await vaultService.deleteNote(deletingItem.id);
      }
    }
    setDeletingItem(null);
  };

  const cancelDelete = () => {
    setDeletingItem(null);
  };

  const handleContextMenu = async (e: React.MouseEvent, conversationId: string) => {
    e.preventDefault();

    // Try conversation first, then trigger
    let filePath = await vaultService.getConversationFilePath(conversationId);
    const isTrigger = !filePath;
    if (!filePath) {
      filePath = await vaultService.getTriggerFilePath(conversationId);
    }
    if (!filePath) return;

    try {
      const menuItems = [];

      // Rename is only available for conversations, not triggers
      if (!isTrigger) {
        menuItems.push({
          id: 'rename',
          text: 'Rename',
          action: () => {
            startRename(conversationId);
          }
        });
      }

      menuItems.push({
        id: 'delete',
        text: 'Delete',
        action: () => {
          setDeletingItem({ type: isTrigger ? 'trigger' : 'conversation', id: conversationId });
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

      const menu = await Menu.new({ items: menuItems });
      await menu.popup();
    } catch (error) {
      console.error('Failed to show context menu:', error);
    }
  };

  const handleNoteContextMenu = async (e: React.MouseEvent, filename: string) => {
    e.preventDefault();

    const filePath = await vaultService.getNoteFilePath(filename);
    if (!filePath) return;

    try {
      const menuItems = [
        {
          id: 'delete',
          text: 'Delete',
          action: () => {
            setDeletingItem({ type: 'note', id: filename });
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
          },
          {
            id: 'new-council',
            text: 'New Council',
            action: () => {
              onNewCouncil();
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
            id: 'manage-triggers',
            text: 'Manage Triggers',
            action: () => {
              onOpenTriggerManagement();
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
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    // Today: show relative time
    if (date.toDateString() === now.toDateString()) {
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} min ago`;
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    }

    // Yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }

    // Older
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  const getModelDisplayName = (modelString: string) => {
    // modelString is in format "provider/model-id" - same as model.key
    const model = availableModels.find(m => m.key === modelString);
    if (model) return model.name;
    // Fallback: extract model ID from string for display
    const slashIndex = modelString.indexOf('/');
    return slashIndex !== -1 ? modelString.slice(slashIndex + 1) : modelString;
  };

  // Combine conversations with triggers that have fired
  // Triggers are stored separately but displayed in the same list
  const visibleConversations = useMemo(() => {
    // Regular conversations (no trigger field)
    const regularConvs = conversations.filter(c => !c.trigger);

    // Triggers that have fired (shown as conversations)
    const firedTriggers = triggers
      .filter(t => t.trigger.lastTriggered !== undefined)
      .map(t => ({
        ...t,
        // Ensure trigger conversations have the trigger field for display logic
      } as Conversation));

    // Combine and sort by updated date
    return [...regularConvs, ...firedTriggers].sort((a, b) =>
      new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
    );
  }, [conversations, triggers]);

  const filteredConversations = visibleConversations.filter((conversation) => {
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

  // Filter notes by search query (filename only)
  const filteredNotes = notes.filter((note) => {
    if (!searchQuery.trim()) return true;
    return note.filename.toLowerCase().includes(searchQuery.toLowerCase());
  });

  // Split into regular notes and rambles
  const regularNotes = filteredNotes.filter(note => !note.filename.startsWith('rambles/'));
  const rambleNotes = filteredNotes.filter(note => note.filename.startsWith('rambles/'));

  return (
    <div className={`sidebar ${fullScreen ? 'full-screen' : ''}`}>
      {fullScreen && onMobileBack && (
        <div className="mobile-sidebar-header">
          <button className="mobile-back-button" onClick={onMobileBack}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <h2>Conversations</h2>
        </div>
      )}
      <div className="search-box" data-tauri-drag-region>
        <button
          className={`back-button ${!canGoBack ? 'disabled' : ''}`}
          onClick={onGoBack}
          disabled={!canGoBack}
          title="Go back"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <div className="search-input-wrapper">
          <input
            ref={searchInputRef}
            type="text"
            placeholder={activeTab === 'chats' ? "Search conversations..." : "Search notes..."}
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

      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${activeTab === 'chats' ? 'active' : ''}`}
          onClick={() => onTabChange('chats')}
        >
          Chats
        </button>
        <button
          className={`sidebar-tab ${activeTab === 'notes' ? 'active' : ''}`}
          onClick={() => onTabChange('notes')}
        >
          Notes
        </button>
      </div>

      {activeTab === 'chats' ? (
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
              }${conversation.comparison ? ' comparison' : ''}${conversation.council ? ' council' : ''}${conversation.trigger ? ' trigger' : ''}${
                streamingConversationIds.includes(conversation.id) ? ' streaming' : ''
              }`}
              onClick={() => handleSelectConversation(conversation.id)}
              onContextMenu={(e) => handleContextMenu(e, conversation.id)}
            >
              <div className="conversation-preview">
                {streamingConversationIds.includes(conversation.id) && (
                  <span className="streaming-indicator" title="Streaming...">●</span>
                )}
                {!streamingConversationIds.includes(conversation.id) && (unreadConversationIds.includes(conversation.id) || firedTriggerIds.includes(conversation.id)) && (
                  <span className="unread-indicator" title={firedTriggerIds.includes(conversation.id) ? "Trigger fired" : "New response"}>●</span>
                )}
                {conversation.comparison && <span className="comparison-badge">Compare</span>}
                {conversation.council && <span className="council-badge">Council</span>}
                {conversation.trigger && <span className="trigger-badge">Trigger</span>}
                {getConversationTitle(conversation)}
              </div>
              <div className="conversation-meta">
                <span className="conversation-date">{formatDate(conversation.updated || conversation.created)}</span>
                {!conversation.comparison && !conversation.council && !conversation.trigger && (
                  <span className="conversation-model" title={conversation.model}>
                    {getModelDisplayName(conversation.model)}
                  </span>
                )}
                {conversation.trigger && (
                  <button
                    className="trigger-settings-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTriggerManagement();
                    }}
                    title="Manage triggers"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      ) : (
      <div className="notes-list">
        {filteredNotes.length === 0 && notes.length === 0 ? (
          <div className="no-conversations">
            <p>No notes yet</p>
            <p className="hint">Notes will appear here</p>
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="no-conversations">
            <p>No results found</p>
            <p className="hint">Try a different search</p>
          </div>
        ) : (
          <>
            {/* Regular notes */}
            {regularNotes.map((note) => (
              <div
                key={note.filename}
                className={`note-item ${selectedNoteFilename === note.filename ? 'active' : ''}`}
                onClick={() => onSelectNote(note.filename)}
                onContextMenu={(e) => handleNoteContextMenu(e, note.filename)}
              >
                {note.hasSkillContent && (
                  <span className="skill-indicator" title="Contains AI content">●</span>
                )}
                <span className="note-title">{note.filename.replace(/\.md$/, '')}</span>
              </div>
            ))}

            {/* Rambles section */}
            {rambleNotes.length > 0 && (
              <>
                <div className="notes-section-header">Rambles</div>
                {rambleNotes.map((note) => (
                  <div
                    key={note.filename}
                    className={`note-item ${selectedNoteFilename === note.filename ? 'active' : ''}`}
                    onClick={() => onSelectNote(note.filename)}
                    onContextMenu={(e) => handleNoteContextMenu(e, note.filename)}
                  >
                    {note.hasSkillContent && (
                      <span className="skill-indicator" title="Contains AI content">●</span>
                    )}
                    <span className="note-title">{note.filename.replace('rambles/', '').replace(/\.md$/, '')}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      )}

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

      {deletingItem && (
        <div className="rename-modal" onClick={cancelDelete}>
          <div className="rename-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete {deletingItem.type === 'conversation' ? 'Conversation' : 'Note'}</h3>
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
