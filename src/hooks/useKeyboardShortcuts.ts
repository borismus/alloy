import { useEffect } from 'react';
import { SidebarHandle } from '../components/Sidebar';
import { FindInConversationHandle } from '../components/FindInConversation';
import { SelectedItem } from '../types';

interface KeyboardShortcutDeps {
  showSettings: boolean;
  showFind: boolean;
  selectedItem: SelectedItem;
  onNewConversation: () => void;
  setShowSettings: (show: boolean) => void;
  setShowFind: (show: boolean) => void;
  setSelectedItem: (item: SelectedItem) => void;
  setNoteContent: (content: string | null) => void;
  sidebarRef: React.RefObject<SidebarHandle | null>;
  findRef: React.RefObject<FindInConversationHandle | null>;
}

export function useKeyboardShortcuts(deps: KeyboardShortcutDeps) {
  const {
    showSettings, showFind, selectedItem,
    onNewConversation, setShowSettings, setShowFind,
    setSelectedItem, setNoteContent,
    sidebarRef, findRef,
  } = deps;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        onNewConversation();
      }

      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      }

      // Cmd+Shift+F: Focus sidebar search
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        sidebarRef.current?.focusSearch();
        return;
      }

      // Cmd+F: Find in current view
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (showFind) {
          findRef.current?.focus();
        } else {
          setShowFind(true);
        }
      }

      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false);
        return;
      }

      // Escape with no modals: deselect item
      if (e.key === 'Escape' && !showSettings && selectedItem && !e.defaultPrevented) {
        setSelectedItem(null);
        setNoteContent(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, showFind, selectedItem, onNewConversation, setShowSettings, setShowFind, setSelectedItem, setNoteContent, sidebarRef, findRef]);

  // Close find when switching views
  useEffect(() => {
    setShowFind(false);
  }, [selectedItem?.id, setShowFind]);
}
