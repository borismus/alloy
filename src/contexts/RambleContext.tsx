import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { ProposedChange, NoteInfo } from '../types';
import { rambleService } from '../services/ramble';
import { vaultService } from '../services/vault';

type RamblePhase = 'idle' | 'rambling' | 'integrating' | 'approving';

interface RambleState {
  isRambling: boolean;
  currentRambleNote: string | null;  // e.g., "rambles/2026-02-02-143052.md"
  rawInput: string;                   // accumulated raw input (scratch buffer)
  lastCrystallizedInput: string;      // input at last crystallization (to detect changes)
  lastCrystallizeTime: number;        // timestamp of last crystallization
  phase: RamblePhase;
  isProcessing: boolean;
  proposedChanges: ProposedChange[];
}

interface RambleContextValue extends RambleState {
  startRamble: () => Promise<string>;     // creates timestamped ramble note, returns filename
  updateRawInput: (text: string) => void; // called on every keystroke
  crystallizeNow: (model: string, notes: NoteInfo[]) => Promise<void>; // rewrite entire note
  finishRamble: (model: string, notes: NoteInfo[]) => Promise<void>;   // triggered by Enter key
  integrateExistingRamble: (ramblePath: string, model: string, notes: NoteInfo[]) => Promise<void>; // integrate an old ramble
  applyChanges: () => Promise<void>;
  cancelIntegration: () => void;
  reset: () => void;
}

// Number of words from crystallized text to include as context overlap
const CONTEXT_OVERLAP_WORDS = 15;

// Get the last N words from a string (for context overlap)
const getLastNWords = (text: string, n: number): string => {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text;
  return words.slice(-n).join(' ');
};

const initialState: RambleState = {
  isRambling: false,
  currentRambleNote: null,
  rawInput: '',
  lastCrystallizedInput: '',
  lastCrystallizeTime: 0,
  phase: 'idle',
  isProcessing: false,
  proposedChanges: [],
};

const RambleContext = createContext<RambleContextValue | null>(null);

interface RambleProviderProps {
  children: React.ReactNode;
  onSelectNote?: (filename: string) => void;
}

export const RambleProvider: React.FC<RambleProviderProps> = ({
  children,
  onSelectNote,
}) => {
  const [state, setState] = useState<RambleState>(initialState);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);

  // Keep ref in sync with state
  stateRef.current = state;

  const startRamble = useCallback(async (): Promise<string> => {
    // Guard: ensure vault is loaded
    if (!rambleService.getVaultPath()) {
      console.warn('[RambleContext] Cannot start ramble: vault path not set');
      return '';
    }

    const filename = await rambleService.getOrCreateRambleNote();

    setState(prev => ({
      ...prev,
      isRambling: true,
      currentRambleNote: filename,
      rawInput: '',
      lastCrystallizedInput: '',
      lastCrystallizeTime: Date.now(),
      phase: 'rambling',
    }));

    // Auto-select the ramble note
    if (onSelectNote) {
      onSelectNote(filename);
    }

    return filename;
  }, [onSelectNote]);

  const updateRawInput = useCallback((text: string) => {
    setState(prev => ({ ...prev, rawInput: text }));
  }, []);

  // Check if we should trigger crystallization
  const shouldCrystallize = useCallback(() => {
    const current = stateRef.current;
    const now = Date.now();
    const timeSinceLastCrystallize = now - current.lastCrystallizeTime;
    const inputChanged = current.rawInput !== current.lastCrystallizedInput;
    const hasContent = current.rawInput.trim().length > 0;

    // Crystallize if: input has changed AND (5+ seconds passed OR significant new content)
    const significantChange = current.rawInput.length - current.lastCrystallizedInput.length >= 100;
    const timeBasedTrigger = timeSinceLastCrystallize >= 5000 && inputChanged;
    const contentBasedTrigger = timeSinceLastCrystallize >= 2000 && significantChange;

    return hasContent && (timeBasedTrigger || contentBasedTrigger);
  }, []);

  // Crystallize: incrementally extend note with new input only
  const crystallizeNow = useCallback(async (model: string, notes: NoteInfo[]) => {
    const current = stateRef.current;
    if (current.isProcessing || !current.currentRambleNote) return;
    if (!current.rawInput.trim()) return;

    // Check trigger conditions
    if (!shouldCrystallize()) return;

    // Calculate incremental text (only what's new since last crystallization)
    const incrementalText = current.rawInput.slice(current.lastCrystallizedInput.length);
    if (!incrementalText.trim()) return;  // Nothing new to crystallize

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      abortControllerRef.current = new AbortController();

      // Include context overlap from crystallized text for better LLM understanding
      const contextOverlap = getLastNWords(current.lastCrystallizedInput, CONTEXT_OVERLAP_WORDS);
      const textWithContext = contextOverlap ? `${contextOverlap} ${incrementalText}` : incrementalText;

      // Crystallize with context overlap
      await rambleService.crystallize(
        textWithContext,
        current.currentRambleNote,
        notes,
        model,
        abortControllerRef.current.signal
      );

      setState(prev => ({
        ...prev,
        lastCrystallizedInput: prev.rawInput,  // Mark all current input as crystallized
        lastCrystallizeTime: Date.now(),
        isProcessing: false,
      }));
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        console.error('[RambleContext] Crystallization error:', error);
      }
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  }, [shouldCrystallize]);

  const finishRamble = useCallback(async (model: string, notes: NoteInfo[]) => {
    const current = stateRef.current;

    // Cancel any ongoing processing
    abortControllerRef.current?.abort();

    // Final crystallization if there's unprocessed input
    const incrementalText = current.rawInput.slice(current.lastCrystallizedInput.length);
    if (incrementalText.trim() && current.currentRambleNote) {
      setState(prev => ({ ...prev, isProcessing: true }));
      try {
        // Include context overlap from crystallized text
        const contextOverlap = getLastNWords(current.lastCrystallizedInput, CONTEXT_OVERLAP_WORDS);
        const textWithContext = contextOverlap ? `${contextOverlap} ${incrementalText}` : incrementalText;

        await rambleService.crystallize(
          textWithContext,
          current.currentRambleNote,
          notes,
          model
        );
      } catch (error) {
        console.error('[RambleContext] Final crystallization error:', error);
      }
    }

    // Switch to integrating phase
    setState(prev => ({
      ...prev,
      phase: 'integrating',
      isProcessing: true,
    }));

    // Generate integration proposals
    if (current.currentRambleNote) {
      try {
        const proposals = await rambleService.generateIntegrationProposal(
          current.currentRambleNote,
          notes,
          model
        );

        setState(prev => ({
          ...prev,
          phase: 'approving',
          isProcessing: false,
          proposedChanges: proposals,
        }));
      } catch (error) {
        console.error('[RambleContext] Integration proposal error:', error);
        setState(prev => ({
          ...prev,
          phase: 'idle',
          isProcessing: false,
        }));
      }
    }
  }, []);

  // Integrate an existing ramble note (not from active rambling session)
  const integrateExistingRamble = useCallback(async (ramblePath: string, model: string, notes: NoteInfo[]) => {
    setState(prev => ({
      ...prev,
      currentRambleNote: ramblePath,
      phase: 'integrating',
      isProcessing: true,
    }));

    try {
      const proposals = await rambleService.generateIntegrationProposal(
        ramblePath,
        notes,
        model
      );

      setState(prev => ({
        ...prev,
        phase: 'approving',
        isProcessing: false,
        proposedChanges: proposals,
      }));
    } catch (error) {
      console.error('[RambleContext] Integration proposal error:', error);
      setState(prev => ({
        ...prev,
        phase: 'idle',
        isProcessing: false,
      }));
    }
  }, []);

  const applyChanges = useCallback(async () => {
    if (stateRef.current.proposedChanges.length === 0) {
      setState(initialState);
      return;
    }

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      const vaultPath = vaultService.getVaultPath();
      if (vaultPath) {
        // Pass ramble note path for provenance tracking
        await rambleService.applyProposedChanges(
          stateRef.current.proposedChanges,
          vaultPath,
          stateRef.current.currentRambleNote || undefined
        );
      }

      // Reset state after successful apply
      setState(initialState);
    } catch (error) {
      console.error('[RambleContext] Apply changes error:', error);
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  }, []);

  const cancelIntegration = useCallback(() => {
    setState(initialState);
  }, []);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    setState(initialState);
  }, []);

  const value: RambleContextValue = {
    ...state,
    startRamble,
    updateRawInput,
    crystallizeNow,
    finishRamble,
    integrateExistingRamble,
    applyChanges,
    cancelIntegration,
    reset,
  };

  return (
    <RambleContext.Provider value={value}>
      {children}
    </RambleContext.Provider>
  );
};

export const useRambleContext = (): RambleContextValue => {
  const context = useContext(RambleContext);
  if (!context) {
    throw new Error('useRambleContext must be used within a RambleProvider');
  }
  return context;
};

// Hook that returns null if not inside provider (for optional usage)
export const useRambleContextOptional = (): RambleContextValue | null => {
  return useContext(RambleContext);
};
