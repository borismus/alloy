import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { ProposedChange, NoteInfo } from '../types';
import { rambleService } from '../services/ramble';
import { vaultService } from '../services/vault';

type RamblePhase = 'idle' | 'rambling' | 'integrating' | 'approving';

interface RambleState {
  // Core ramble state (simplified)
  rawLog: string;                // The full user input, append-only
  crystallizedOffset: number;    // How many chars have been processed
  draftFilename: string | null;  // Active draft being updated
  isDirty: boolean;              // True if user has typed since opening draft

  // UI state
  isRambleMode: boolean;
  isCrystallizing: boolean;
  isProcessing: boolean;         // Blocks UI (integration, apply)
  phase: RamblePhase;
  crystallizationCount: number;  // Increments each time crystallization completes

  // Integration state
  proposedChanges: ProposedChange[];
}

interface RambleContextValue extends RambleState {
  // Core methods
  setRawLog: (newLog: string) => void;

  // Mode management
  enterRambleMode: (draftFilename?: string) => void;
  exitRambleMode: () => void;

  // Integration
  integrateNow: () => Promise<void>;
  applyChanges: () => Promise<void>;
  cancelIntegration: () => void;

  // Config (must be set before entering ramble mode)
  setConfig: (model: string, notes: NoteInfo[]) => void;
}

const initialState: RambleState = {
  rawLog: '',
  crystallizedOffset: 0,
  draftFilename: null,
  isDirty: false,
  isRambleMode: false,
  isCrystallizing: false,
  isProcessing: false,
  phase: 'idle',
  crystallizationCount: 0,
  proposedChanges: [],
};

const RambleContext = createContext<RambleContextValue | null>(null);

// Thresholds
const PAUSE_DELAY_MS = 800;       // Crystallize after this pause
const MIN_CHARS_TO_CRYSTALLIZE = 20;
const EMERGENCY_THRESHOLD = 200;  // Crystallize immediately if this many chars pending
const PERSIST_DELAY_MS = 2000;    // Save to disk after this pause

interface RambleProviderProps {
  children: React.ReactNode;
}

export const RambleProvider: React.FC<RambleProviderProps> = ({ children }) => {
  const [state, setState] = useState<RambleState>(initialState);

  // Refs for timers and config
  const crystallizeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const persistTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  // Synchronous ref for crystallizing flag - prevents race conditions
  // (setState is async, so stateRef.current.isCrystallizing can be stale)
  const isCrystallizingRef = useRef(false);

  // Config refs (model and notes for crystallization)
  const modelRef = useRef<string>('');
  const notesRef = useRef<NoteInfo[]>([]);

  // Keep stateRef in sync
  stateRef.current = state;

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (crystallizeTimerRef.current) clearTimeout(crystallizeTimerRef.current);
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  // Set config (model and notes) - must be called before rambling
  const setConfig = useCallback((model: string, notes: NoteInfo[]) => {
    modelRef.current = model;
    notesRef.current = notes;
  }, []);

  // Get pending text (not yet crystallized)
  const getPendingText = useCallback((): string => {
    return stateRef.current.rawLog.slice(stateRef.current.crystallizedOffset);
  }, []);

  // Persist rawLog and crystallizedOffset to draft frontmatter (for crash recovery)
  const persistToDraft = useCallback(async () => {
    const { draftFilename, rawLog, crystallizedOffset, isDirty } = stateRef.current;
    // Only persist if user has actually typed something
    if (!draftFilename || !rawLog || !isDirty) return;

    try {
      await rambleService.updateDraftRawInput(draftFilename, rawLog, crystallizedOffset);
    } catch (error) {
      console.error('[RambleContext] Failed to persist:', error);
    }
  }, []);

  // Crystallize pending text
  const crystallizeNow = useCallback(async () => {
    const current = stateRef.current;

    // Guards - use synchronous ref to prevent race conditions
    // (setState is async, so checking state.isCrystallizing can allow duplicates)
    if (isCrystallizingRef.current) return;
    if (!current.draftFilename) return;

    const pendingText = current.rawLog.slice(current.crystallizedOffset);
    if (!pendingText.trim()) return;

    // Set flag synchronously BEFORE any async work
    isCrystallizingRef.current = true;

    // Capture the target offset NOW, before async work
    // This is the length of rawLog at crystallization start - any text added
    // during crystallization should NOT be marked as crystallized
    const targetOffset = current.rawLog.length;


    setState(prev => ({ ...prev, isCrystallizing: true }));

    try {
      abortControllerRef.current = new AbortController();

      await rambleService.crystallize(
        pendingText,
        current.draftFilename,
        notesRef.current,
        modelRef.current,
        abortControllerRef.current.signal
      );

      // Advance the offset to mark only the text that was actually crystallized
      // Use the captured targetOffset, not prev.rawLog.length, to avoid marking
      // text typed during crystallization as already processed
      isCrystallizingRef.current = false;
      setState(prev => ({
        ...prev,
        crystallizedOffset: targetOffset,
        isCrystallizing: false,
        crystallizationCount: prev.crystallizationCount + 1,
      }));

    } catch (error: any) {
      isCrystallizingRef.current = false;
      if (error?.name !== 'AbortError') {
        console.error('[RambleContext] Crystallization error:', error);
      }
      setState(prev => ({ ...prev, isCrystallizing: false }));
    }
  }, []);

  // Schedule crystallization with debounce
  const schedulecrystallization = useCallback(() => {
    // Clear existing timer
    if (crystallizeTimerRef.current) {
      clearTimeout(crystallizeTimerRef.current);
      crystallizeTimerRef.current = null;
    }

    const pending = getPendingText();

    // Emergency valve - too much text, crystallize now
    if (pending.length >= EMERGENCY_THRESHOLD) {
      crystallizeNow();
      return;
    }

    // Normal pause-based trigger
    if (pending.trim().length >= MIN_CHARS_TO_CRYSTALLIZE) {
      crystallizeTimerRef.current = setTimeout(() => {
        crystallizeNow();
      }, PAUSE_DELAY_MS);
    }
  }, [getPendingText, crystallizeNow]);

  // Schedule persistence with debounce
  const schedulePersistence = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = setTimeout(() => {
      persistToDraft();
    }, PERSIST_DELAY_MS);
  }, [persistToDraft]);

  // Update the raw log (allows editing pending text, but not crystallized text)
  const setRawLog = useCallback((newLog: string) => {
    const current = stateRef.current.rawLog;
    const addedText = newLog.slice(current.length);

    // macOS dictation duplicate: added text equals existing content
    if (addedText.length > 20 && addedText === current) {
      console.warn('[RambleContext] Duplicate rejected');
      return;
    }

    let didChange = false;
    setState(prev => {
      // Clamp crystallizedOffset to actual content length (handles edge cases)
      const effectiveOffset = Math.min(prev.crystallizedOffset, prev.rawLog.length);

      // Can't shrink below crystallizedOffset (protect crystallized text)
      if (newLog.length < effectiveOffset) {
        const fixedLog = prev.rawLog.slice(0, effectiveOffset) + newLog.slice(effectiveOffset);
        didChange = fixedLog !== prev.rawLog;
        return { ...prev, rawLog: fixedLog, isDirty: prev.isDirty || didChange };
      }
      // Can't modify crystallized portion
      if (!newLog.startsWith(prev.rawLog.slice(0, effectiveOffset))) {
        return prev; // Reject modification to crystallized text
      }
      didChange = newLog !== prev.rawLog;
      return { ...prev, rawLog: newLog, isDirty: prev.isDirty || didChange };
    });

    // Only schedule crystallization and persistence if something changed
    // Note: didChange may not reflect the actual state change due to React batching,
    // but the schedulers check pending text anyway
    schedulecrystallization();
    schedulePersistence();
  }, [schedulecrystallization, schedulePersistence]);

  // Create draft if needed (when enough text accumulates)
  useEffect(() => {
    const createDraftIfNeeded = async () => {
      const { rawLog, draftFilename, isRambleMode, isDirty } = stateRef.current;

      // Only create draft if in ramble mode, no draft yet, user has typed, and enough content
      if (!isRambleMode || draftFilename || !isDirty || rawLog.trim().length < 10) return;

      try {
        const filename = await rambleService.getOrCreateRambleNote(rawLog);
        setState(prev => ({
          ...prev,
          draftFilename: filename,
          phase: 'rambling',
        }));
        console.log('[RambleContext] Created draft:', filename);
      } catch (error) {
        console.error('[RambleContext] Failed to create draft:', error);
      }
    };

    createDraftIfNeeded();
  }, [state.rawLog, state.draftFilename, state.isRambleMode, state.isDirty]);

  // Enter ramble mode
  const enterRambleMode = useCallback(async (existingDraftFilename?: string) => {
    // Clear any existing timers
    if (crystallizeTimerRef.current) clearTimeout(crystallizeTimerRef.current);
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);

    if (existingDraftFilename) {
      // Resume existing draft - load rawInput and crystallizedOffset from frontmatter
      try {
        const { rawInput, crystallizedOffset } = await rambleService.getDraftRawInput(existingDraftFilename);
        setState(prev => ({
          ...prev,
          isRambleMode: true,
          draftFilename: existingDraftFilename,
          rawLog: rawInput,
          crystallizedOffset,
          isDirty: false,
          phase: 'rambling',
        }));
      } catch (error) {
        console.error('[RambleContext] Failed to load rawInput:', error);
        setState(prev => ({
          ...prev,
          isRambleMode: true,
          draftFilename: existingDraftFilename,
          rawLog: '',
          crystallizedOffset: 0,
          isDirty: false,
          phase: 'rambling',
        }));
      }
    } else {
      // Fresh start - empty input
      setState(prev => ({
        ...prev,
        isRambleMode: true,
        draftFilename: null,
        rawLog: '',
        crystallizedOffset: 0,
        isDirty: false,
        phase: 'idle',
      }));
    }
  }, []);

  // Exit ramble mode
  const exitRambleMode = useCallback(async () => {
    // Cancel timers and abort any ongoing crystallization
    if (crystallizeTimerRef.current) clearTimeout(crystallizeTimerRef.current);
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    abortControllerRef.current?.abort();

    // Persist before exiting
    await persistToDraft();

    setState(initialState);
  }, [persistToDraft]);

  // Integrate - crystallize remaining and generate proposals
  const integrateNow = useCallback(async () => {
    const current = stateRef.current;
    if (!current.draftFilename) return;

    // Cancel any pending crystallization
    if (crystallizeTimerRef.current) {
      clearTimeout(crystallizeTimerRef.current);
      crystallizeTimerRef.current = null;
    }

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      // Final crystallization if there's pending text
      const pending = current.rawLog.slice(current.crystallizedOffset);
      const targetOffset = current.rawLog.length; // Capture before async work
      if (pending.trim()) {
        await rambleService.crystallize(
          pending,
          current.draftFilename,
          notesRef.current,
          modelRef.current
        );
        setState(prev => ({ ...prev, crystallizedOffset: targetOffset }));
      }

      // Persist
      await persistToDraft();

      // Generate integration proposals
      setState(prev => ({ ...prev, phase: 'integrating' }));

      const proposals = await rambleService.generateIntegrationProposal(
        current.draftFilename,
        notesRef.current,
        modelRef.current
      );

      setState(prev => ({
        ...prev,
        phase: 'approving',
        isProcessing: false,
        proposedChanges: proposals,
      }));
    } catch (error) {
      console.error('[RambleContext] Integration error:', error);
      setState(prev => ({
        ...prev,
        phase: 'rambling',
        isProcessing: false,
      }));
    }
  }, [persistToDraft]);

  // Apply proposed changes
  const applyChanges = useCallback(async () => {
    const { proposedChanges, draftFilename } = stateRef.current;
    if (proposedChanges.length === 0) {
      setState(initialState);
      return;
    }

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      const vaultPath = vaultService.getVaultPath();
      if (vaultPath) {
        await rambleService.applyProposedChanges(
          proposedChanges,
          vaultPath,
          draftFilename || undefined
        );
      }

      setState(initialState);
    } catch (error) {
      console.error('[RambleContext] Apply changes error:', error);
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  }, []);

  // Cancel integration
  const cancelIntegration = useCallback(() => {
    setState(prev => ({
      ...prev,
      phase: 'rambling',
      isProcessing: false,
      proposedChanges: [],
    }));
  }, []);

  const value: RambleContextValue = {
    ...state,
    setRawLog,
    enterRambleMode,
    exitRambleMode,
    integrateNow,
    applyChanges,
    cancelIntegration,
    setConfig,
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

export const useRambleContextOptional = (): RambleContextValue | null => {
  return useContext(RambleContext);
};
