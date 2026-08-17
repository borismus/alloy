import { useState, useCallback } from 'react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { vaultService } from '../services/vault';
import { loadSelectedItem, saveSelectedItem } from '../services/selectionStorage';
import { SelectedItem } from '../types';

export function useNavigation() {
  const [selectedItem, setSelectedItemRaw] = useState<SelectedItem>(loadSelectedItem);

  const setSelectedItem = useCallback((item: SelectedItem) => {
    setSelectedItemRaw(item);
    saveSelectedItem(item);
  }, []);

  const [previousItem, setPreviousItem] = useState<SelectedItem>(null);

  const navigateTo = useCallback((item: SelectedItem) => {
    if (selectedItem) {
      setPreviousItem(selectedItem);
    }
    setSelectedItem(item);
  }, [selectedItem, setSelectedItem]);

  // noteContentSetter is injected by App since note content state lives there
  const goBack = useCallback(async (noteContentSetter: (content: string | null) => void, draftSetter: (draft: null) => void) => {
    if (!previousItem) return;

    if (previousItem.type === 'note') {
      const filename = previousItem.id;
      const vaultPathStr = vaultService.getVaultPath();
      const notesPath = vaultService.getNotesPath();
      if (vaultPathStr && notesPath) {
        const notePath = filename === 'memory.md' || filename.startsWith('riffs/')
          ? `${vaultPathStr}/${filename}`
          : `${notesPath}/${filename}`;
        try {
          const content = await readTextFile(notePath);
          noteContentSetter(content);
        } catch (error) {
          console.error('[Navigation] Failed to load note on back:', error);
        }
      }
    } else {
      noteContentSetter(null);
    }

    setSelectedItem(previousItem);
    setPreviousItem(null);
    draftSetter(null);
  }, [previousItem, setSelectedItem]);

  const canGoBack = previousItem !== null;

  return {
    selectedItem,
    setSelectedItem,
    previousItem,
    navigateTo,
    goBack,
    canGoBack,
  };
}
