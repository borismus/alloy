import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { ProposedChange, NoteInfo } from '../types';
import { rambleService } from '../services/ramble';
import { vaultService } from '../services/vault';

type RamblePhase = 'idle' | 'rambling' | 'integrating' | 'approving';

interface RambleState {
  isRambling: boolean;
  currentRambleNote: string | null;  // e.g., "rambles/2026-02-02-143052.md"
  rawInput: string;                   // accumulated raw input from sidebar
  lastProcessedIndex: number;         // track what's been processed
  lastProcessedTime: number;          // timestamp of last process
  phase: RamblePhase;
  isProcessing: boolean;
  proposedChanges: ProposedChange[];
}

interface RambleContextValue extends RambleState {
  startRamble: () => Promise<string>;     // creates timestamped ramble note, returns filename
  updateRawInput: (text: string) => void; // called on every keystroke
  processInputNow: (model: string, notes: NoteInfo[]) => Promise<void>; // process accumulated input
  finishRamble: (model: string, notes: NoteInfo[]) => Promise<void>;    // triggered by Enter key
  applyChanges: () => Promise<void>;
  cancelIntegration: () => void;
  reset: () => void;
}

const initialState: RambleState = {
  isRambling: false,
  currentRambleNote: null,
  rawInput: '',
  lastProcessedIndex: 0,
  lastProcessedTime: 0,
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
    const filename = await rambleService.getOrCreateRambleNote();

    setState(prev => ({
      ...prev,
      isRambling: true,
      currentRambleNote: filename,
      rawInput: '',
      lastProcessedIndex: 0,
      lastProcessedTime: Date.now(),
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

  // Check if we should trigger processing
  const shouldProcess = useCallback(() => {
    const current = stateRef.current;
    const now = Date.now();
    const timeSinceLastProcess = now - current.lastProcessedTime;
    const newChars = current.rawInput.length - current.lastProcessedIndex;

    // Primary trigger: (2+ sec since last) AND (50+ new chars)
    const primaryTrigger = timeSinceLastProcess >= 2000 && newChars >= 50;

    // Fallback trigger: (5+ sec since last) AND (any new input)
    const fallbackTrigger = timeSinceLastProcess >= 5000 && newChars > 0;

    return primaryTrigger || fallbackTrigger;
  }, []);

  // Process accumulated input - called by NoteChatSidebar with current model
  const processInputNow = useCallback(async (model: string, notes: NoteInfo[]) => {
    const current = stateRef.current;
    if (current.isProcessing || !current.currentRambleNote) return;

    const newInput = current.rawInput.slice(current.lastProcessedIndex);
    if (!newInput.trim()) return;

    // Check trigger conditions
    if (!shouldProcess()) return;

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      abortControllerRef.current = new AbortController();

      await rambleService.processRambleInput(
        newInput,
        current.currentRambleNote,
        notes,
        model,
        abortControllerRef.current.signal
      );

      setState(prev => ({
        ...prev,
        lastProcessedIndex: prev.rawInput.length,
        lastProcessedTime: Date.now(),
        isProcessing: false,
      }));
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        console.error('[RambleContext] Processing error:', error);
      }
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  }, [shouldProcess]);

  const finishRamble = useCallback(async (model: string, notes: NoteInfo[]) => {
    const current = stateRef.current;

    // Cancel any ongoing processing
    abortControllerRef.current?.abort();

    // Process any remaining input
    const newInput = current.rawInput.slice(current.lastProcessedIndex);
    if (newInput.trim() && current.currentRambleNote) {
      setState(prev => ({ ...prev, isProcessing: true }));
      try {
        await rambleService.processRambleInput(
          newInput,
          current.currentRambleNote,
          notes,
          model
        );
      } catch (error) {
        console.error('[RambleContext] Final processing error:', error);
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

  const applyChanges = useCallback(async () => {
    if (stateRef.current.proposedChanges.length === 0) {
      setState(initialState);
      return;
    }

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      const vaultPath = vaultService.getVaultPath();
      if (vaultPath) {
        await rambleService.applyProposedChanges(stateRef.current.proposedChanges, vaultPath);
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
    processInputNow,
    finishRamble,
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
