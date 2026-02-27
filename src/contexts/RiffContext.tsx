import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { ProposedChange, NoteInfo, RiffArtifactType, RiffMessage, RiffComment } from '../types';
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

  // Comments
  comments: RiffComment[];
  isCommenting: boolean;           // AI generating comments

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

  // Comments
  resolveComment: (commentId: string) => void;

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
  comments: [],
  isCommenting: false,
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

  // Generate comments asynchronously (independent from artifact updates)
  const generateCommentsAsync = useCallback(async (draftFilename: string, recentInput: string) => {
    if (!modelRef.current) return;

    // Derive eagerness from existing state: how many messages since the last comment?
    const { messages, comments } = stateRef.current;
    const lastCommentTime = comments.length > 0
      ? Math.max(...comments.map(c => new Date(c.timestamp).getTime()))
      : 0;
    const messagesSinceLastComment = lastCommentTime === 0
      ? messages.length
      : messages.filter(m => new Date(m.timestamp).getTime() > lastCommentTime).length;

    // Existing comment paragraph indices for density filtering
    const existingCommentParagraphs = comments.map(c => c.anchor.paragraphIndex);

    setState(prev => ({ ...prev, isCommenting: true }));
    try {
      const commentAbort = new AbortController();
      const newComments = await riffService.generateComments(
        draftFilename,
        recentInput,
        notesRef.current,
        modelRef.current,
        commentAbort.signal,
        messagesSinceLastComment,
        existingCommentParagraphs
      );
      setState(prev => {
        const merged = [...prev.comments, ...newComments];
        riffService.updateDraftComments(draftFilename, merged);
        return { ...prev, comments: merged, isCommenting: false };
      });
    } catch (error) {
      console.error('[RiffContext] Comment generation error:', error);
      setState(prev => ({ ...prev, isCommenting: false }));
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
    const userSetType = current.artifactTypeSetByUser;

    fireUpdate(async () => {
      // Detect artifact type on every message (unless user explicitly set via dropdown)
      let artifactType = stateRef.current.artifactType;
      if (!userSetType && modelRef.current) {
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
        // Classify input (append vs command)
        const action = await riffService.classifyInput(messageText);
        // Update the message's action in state
        const msgWithAction: RiffMessage = { ...newMessage, action };
        setState(prev => ({
          ...prev,
          messages: prev.messages.map(m =>
            m.timestamp === newMessage.timestamp ? msgWithAction : m
          ),
        }));

        if (action === 'append') {
          await riffService.appendToDocument(draftFn, messageText);
        } else {
          await riffService.applyCommand(messageText, draftFn, modelRef.current);
        }

        await riffService.updateDraftMessages(draftFn, stateRef.current.messages, artifactType);
        generateCommentsAsync(draftFn, messageText);
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
  }, [fireUpdate, generateCommentsAsync]);

  // Resolve (dismiss) a comment
  const resolveComment = useCallback(async (commentId: string) => {
    const current = stateRef.current;
    const updated = current.comments.filter(c => c.id !== commentId);
    setState(prev => ({ ...prev, comments: updated }));

    // Persist to frontmatter
    if (current.draftFilename) {
      try {
        await riffService.updateDraftComments(current.draftFilename, updated);
      } catch (error) {
        console.error('[RiffContext] Failed to persist comment removal:', error);
      }
    }
  }, []);

  // Enter riff mode
  const enterRiffMode = useCallback(async (existingDraftFilename?: string) => {

    if (existingDraftFilename) {
      // Resume existing draft - load messages, artifactType, and comments from frontmatter
      try {
        const { messages, artifactType, comments } = await riffService.getDraftMessages(existingDraftFilename);
        setState(prev => ({
          ...prev,
          isRiffMode: true,
          draftFilename: existingDraftFilename,
          inputText: '',
          messages,
          artifactType,
          artifactTypeSetByUser: true,  // Don't re-detect when resuming
          comments,
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
          comments: [],
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
        comments: [],
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
    resolveComment,
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
