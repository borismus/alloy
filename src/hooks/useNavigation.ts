import { useState, useCallback } from 'react';
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
      try {
        const content = await vaultService.readNote(previousItem.id);
        if (content !== null) noteContentSetter(content);
      } catch (error) {
        console.error('[Navigation] Failed to load note on back:', error);
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
