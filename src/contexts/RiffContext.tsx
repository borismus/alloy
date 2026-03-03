import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { ProposedChange, NoteInfo, RiffArtifactType, RiffMessage, RiffIntervention } from '../types';
import { riffService } from '../services/riff';
import { vaultService } from '../services/vault';

type RiffPhase = 'idle' | 'riffing' | 'integrating' | 'approving';

interface RiffState {
  // Input
  inputText: string;               // Current textarea value, clears after send
  messages: RiffMessage[];         // Sent message history

  // Draft
  draftFilename: string | null;
  artifactType: RiffArtifactType;
  artifactTypeSetByUser: boolean;

  // Interventions
  interventions: RiffIntervention[];
  isGeneratingIntervention: boolean;           // AI generating interventions

  // UI state
  isRiffMode: boolean;
  isUpdating: boolean;             // LLM working on artifact update (command or mermaid/table)
  isProcessing: boolean;           // Integration/apply in progress
  phase: RiffPhase;

  // Integration state
  proposedChanges: ProposedChange[];
}

interface RiffContextValue extends RiffState {
  // Input
  setInputText: (text: string) => void;
  sendMessage: (textOverride?: string) => Promise<void>;

  // Mode management
  enterRiffMode: (draftFilename?: string) => void;
  exitRiffMode: () => void;

  // Artifact type
  setArtifactType: (type: RiffArtifactType) => void;

  // Interventions
  dismissIntervention: (interventionId: string) => void;

  // Integration
  integrateNow: () => Promise<void>;
  applyChanges: () => Promise<void>;
  cancelIntegration: () => void;

  // Config (must be set before entering riff mode)
  setConfig: (model: string, notes: NoteInfo[]) => void;
}

const initialState: RiffState = {
  inputText: '',
  messages: [],
  draftFilename: null,
  artifactType: 'note',
  artifactTypeSetByUser: false,
  interventions: [],
  isGeneratingIntervention: false,
  isRiffMode: false,
  isUpdating: false,
  isProcessing: false,
  phase: 'idle',
  proposedChanges: [],
};

const RiffContext = createContext<RiffContextValue | null>(null);

interface RiffProviderProps {
  children: React.ReactNode;
}

export const RiffProvider: React.FC<RiffProviderProps> = ({ children }) => {
  const [state, setState] = useState<RiffState>(initialState);

  const stateRef = useRef(state);

  // Config refs (model and notes for artifact updates)
  const modelRef = useRef<string>('');
  const notesRef = useRef<NoteInfo[]>([]);

  // Track active parallel updates
  const activeUpdatesRef = useRef(0);

  // Keep stateRef in sync
  stateRef.current = state;

  // Set config (model and notes) - must be called before riffing
  const setConfig = useCallback((model: string, notes: NoteInfo[]) => {
    modelRef.current = model;
    notesRef.current = notes;
  }, []);

  // Set input text (simple setter, no auto-triggers)
  const setInputText = useCallback((text: string) => {
    setState(prev => ({ ...prev, inputText: text }));
  }, []);

  // Persist messages to draft frontmatter
  const persistMessages = useCallback(async () => {
    const { draftFilename, messages, artifactType } = stateRef.current;
    if (!draftFilename || messages.length === 0) return;

    try {
      await riffService.updateDraftMessages(draftFilename, messages, artifactType);
    } catch (error) {
      console.error('[RiffContext] Failed to persist messages:', error);
    }
  }, []);

  // Fire-and-forget LLM work (parallel — no queue, no abort)
  const fireUpdate = useCallback((work: () => Promise<void>) => {
    activeUpdatesRef.current++;
    setState(prev => ({ ...prev, isUpdating: true }));

    (async () => {
      try {
        await work();
      } catch (error: any) {
        console.error('[RiffContext] Update error:', error);
      }
      activeUpdatesRef.current--;
      if (activeUpdatesRef.current === 0) {
        setState(prev => ({ ...prev, isUpdating: false }));
      }
    })();
  }, []);

  // Generate interventions asynchronously (independent from artifact updates)
  const generateInterventionsAsync = useCallback(async (draftFilename: string, recentInput: string) => {
    if (!modelRef.current) return;

    // Derive eagerness from existing state: how many messages since the last intervention?
    const { messages, interventions } = stateRef.current;
    const lastInterventionTime = interventions.length > 0
      ? Math.max(...interventions.map(i => new Date(i.timestamp).getTime()))
      : 0;
    const messagesSinceLastIntervention = lastInterventionTime === 0
      ? messages.length
      : messages.filter(m => new Date(m.timestamp).getTime() > lastInterventionTime).length;

    // Existing intervention paragraph indices for density filtering
    const existingInterventionParagraphs = interventions.map(i => i.anchor.paragraphIndex);

    setState(prev => ({ ...prev, isGeneratingIntervention: true }));
    try {
      const interventionAbort = new AbortController();
      const newInterventions = await riffService.generateInterventions(
        draftFilename,
        recentInput,
        notesRef.current,
        modelRef.current,
        interventionAbort.signal,
        messagesSinceLastIntervention,
        existingInterventionParagraphs
      );
      setState(prev => {
        const merged = [...prev.interventions, ...newInterventions];
        riffService.updateDraftInterventions(draftFilename, merged);
        return { ...prev, interventions: merged, isGeneratingIntervention: false };
      });
    } catch (error) {
      console.error('[RiffContext] Intervention generation error:', error);
      setState(prev => ({ ...prev, isGeneratingIntervention: false }));
    }
  }, []);

  // Send message — adds to history immediately, all LLM work is fire-and-forget
  // textOverride bypasses React state (used by dictation to avoid stale reads)
  const sendMessage = useCallback(async (textOverride?: string) => {
    const current = stateRef.current;
    const messageText = (textOverride ?? current.inputText).trim();
    if (!messageText) return;

    // Clear input immediately
    setState(prev => ({ ...prev, inputText: '' }));

    // Create draft if needed (fast file I/O, only on first message)
    let draftFilename = current.draftFilename;
    if (!draftFilename) {
      draftFilename = await riffService.getOrCreateRiffNote();
      setState(prev => ({ ...prev, draftFilename, phase: 'riffing' }));
    }

    // Add message to state immediately
    const newMessage: RiffMessage = {
      role: 'user',
      timestamp: new Date().toISOString(),
      content: messageText,
    };
    const updatedMessages = [...current.messages, newMessage];
    setState(prev => ({ ...prev, messages: updatedMessages, draftFilename }));

    // All LLM work runs in the background — sendMessage returns here
    const draftFn = draftFilename;
    const isFirstMessage = current.messages.length === 0;
    const userSetType = current.artifactTypeSetByUser;

    fireUpdate(async () => {
      // Auto-detect artifact type only on the first message of a new riff
      let artifactType = stateRef.current.artifactType;
      if (isFirstMessage && !userSetType && modelRef.current) {
        try {
          const detected = await riffService.detectArtifactType(messageText, modelRef.current);
          if (detected !== artifactType) {
            artifactType = detected;
            setState(prev => ({ ...prev, artifactType: detected }));
          }
        } catch (error) {
          console.error('[RiffContext] Failed to detect artifact type:', error);
        }
      }

      if (artifactType === 'note') {
        // Just append - no LLM classification needed for brain dump mode
        await riffService.appendToDocument(draftFn, messageText);
        await riffService.updateDraftMessages(draftFn, stateRef.current.messages, artifactType);

        // Only generate interventions every 3-5 messages (moderate frequency)
        const { interventions } = stateRef.current;
        const lastInterventionTime = interventions.length > 0
          ? Math.max(...interventions.map(i => new Date(i.timestamp).getTime()))
          : 0;
        const messagesSinceLastIntervention = lastInterventionTime === 0
          ? stateRef.current.messages.length
          : stateRef.current.messages.filter(m => new Date(m.timestamp).getTime() > lastInterventionTime).length;

        // Call intervention generation only if 3+ messages have passed
        if (messagesSinceLastIntervention >= 3) {
          generateInterventionsAsync(draftFn, messageText);
        }
      } else {
        // Mermaid/table: AI-rewrite paradigm
        await riffService.updateArtifact(
          messageText,
          stateRef.current.messages,
          draftFn,
          notesRef.current,
          modelRef.current,
          undefined,
          artifactType
        );
        await riffService.updateDraftMessages(draftFn, stateRef.current.messages, artifactType);
      }
    });
  }, [fireUpdate, generateInterventionsAsync]);

  // Dismiss an intervention
  const dismissIntervention = useCallback(async (interventionId: string) => {
    const current = stateRef.current;
    const updated = current.interventions.filter(i => i.id !== interventionId);
    setState(prev => ({ ...prev, interventions: updated }));

    // Persist to frontmatter
    if (current.draftFilename) {
      try {
        await riffService.updateDraftInterventions(current.draftFilename, updated);
      } catch (error) {
        console.error('[RiffContext] Failed to persist intervention removal:', error);
      }
    }
  }, []);

  // Enter riff mode
  const enterRiffMode = useCallback(async (existingDraftFilename?: string) => {

    if (existingDraftFilename) {
      // Resume existing draft - load messages, artifactType, and interventions from frontmatter
      try {
        const { messages, artifactType, interventions } = await riffService.getDraftMessages(existingDraftFilename);
        setState(prev => ({
          ...prev,
          isRiffMode: true,
          draftFilename: existingDraftFilename,
          inputText: '',
          messages,
          artifactType,
          artifactTypeSetByUser: true,  // Don't re-detect when resuming
          interventions,
          phase: 'riffing',
        }));
      } catch (error) {
        console.error('[RiffContext] Failed to load draft messages:', error);
        setState(prev => ({
          ...prev,
          isRiffMode: true,
          draftFilename: existingDraftFilename,
          inputText: '',
          messages: [],
          interventions: [],
          phase: 'riffing',
        }));
      }
    } else {
      // Fresh start - empty
      setState(prev => ({
        ...prev,
        isRiffMode: true,
        draftFilename: null,
        inputText: '',
        messages: [],
        interventions: [],
        artifactType: 'note',
        artifactTypeSetByUser: false,
        phase: 'idle',
      }));
    }
  }, []);

  // Exit riff mode
  const exitRiffMode = useCallback(async () => {

    // Persist messages before exiting
    await persistMessages();

    setState(initialState);
  }, [persistMessages]);

  // Set artifact type (user override)
  const setArtifactType = useCallback(async (type: RiffArtifactType) => {
    const current = stateRef.current;
    if (type === current.artifactType) return;

    setState(prev => ({
      ...prev,
      artifactType: type,
      artifactTypeSetByUser: true,
    }));

    // Update draft body for new type
    if (current.draftFilename) {
      const draftFn = current.draftFilename;
      const msgs = current.messages;

      if (type === 'note') {
        // Note mode: verbatim concat of messages as paragraphs (no AI rewrite)
        const body = msgs.map(m => m.content).join('\n\n');
        await riffService.updateDraft(draftFn, body);
        await riffService.updateDraftMessages(draftFn, msgs, type);
      } else {
        // AI-rewrite for mermaid/table/summary
        await riffService.updateDraft(draftFn, '');
        await riffService.updateDraftMessages(draftFn, msgs, type);

        if (msgs.length > 0 && modelRef.current) {
          fireUpdate(async () => {
            await riffService.updateArtifact(
              msgs[msgs.length - 1].content,
              msgs,
              draftFn,
              notesRef.current,
              modelRef.current,
              undefined,
              type
            );
          });
        }
      }
    }
  }, [fireUpdate]);

  // Integrate - generate proposals
  const integrateNow = useCallback(async () => {
    const current = stateRef.current;
    if (!current.draftFilename) return;

    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      // Persist messages
      await persistMessages();

      // Generate integration proposals
      setState(prev => ({ ...prev, phase: 'integrating' }));

      const proposals = await riffService.generateIntegrationProposal(
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
      console.error('[RiffContext] Integration error:', error);
      setState(prev => ({
        ...prev,
        phase: 'riffing',
        isProcessing: false,
      }));
    }
  }, [persistMessages]);

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
        await riffService.applyProposedChanges(
          proposedChanges,
          vaultPath,
          draftFilename || undefined
        );
      }

      setState(initialState);
    } catch (error) {
      console.error('[RiffContext] Apply changes error:', error);
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  }, []);

  // Cancel integration
  const cancelIntegration = useCallback(() => {
    setState(prev => ({
      ...prev,
      phase: 'riffing',
      isProcessing: false,
      proposedChanges: [],
    }));
  }, []);

  const value: RiffContextValue = {
    ...state,
    setInputText,
    sendMessage,
    enterRiffMode,
    exitRiffMode,
    setArtifactType,
    dismissIntervention,
    integrateNow,
    applyChanges,
    cancelIntegration,
    setConfig,
  };

  return (
    <RiffContext.Provider value={value}>
      {children}
    </RiffContext.Provider>
  );
};

export const useRiffContext = (): RiffContextValue => {
  const context = useContext(RiffContext);
  if (!context) {
    throw new Error('useRiffContext must be used within a RiffProvider');
  }
  return context;
};

export const useRiffContextOptional = (): RiffContextValue | null => {
  return useContext(RiffContext);
};
