import { useState, useRef, useCallback, useEffect } from 'react';
import { ModelInfo, Message, ComparisonResponse, ProviderType } from '../types';
import { providerRegistry } from '../services/providers/registry';
import { useStreamingContext } from '../contexts/StreamingContext';

export type CouncilPhase = 'idle' | 'individual' | 'synthesis' | 'complete';

interface UseCouncilStreamingOptions {
  conversationId: string | null;
  isCurrentConversation: boolean;
  systemPrompt?: string;
  existingMessages: Message[];
}

interface CouncilStreamingResult {
  memberResponses: ComparisonResponse[];
  chairmanResponse: {
    provider: ProviderType;
    model: string;
    content: string;
    status: 'complete' | 'error';
    error?: string;
  };
}

interface UseCouncilStreamingReturn {
  // Phase 1: Council member responses
  memberContents: Map<string, string>;
  memberStatuses: Map<string, ComparisonResponse['status']>;
  memberErrors: Map<string, string>;

  // Phase 2: Chairman response
  chairmanContent: string;
  chairmanStatus: 'idle' | 'pending' | 'streaming' | 'complete' | 'error';
  chairmanError: string | null;

  // Current phase
  currentPhase: CouncilPhase;

  // Actions
  startCouncilStreaming: (
    userMessage: string,
    councilMembers: ModelInfo[],
    chairman: ModelInfo
  ) => Promise<CouncilStreamingResult>;
  stopAll: () => void;
  isAnyStreaming: boolean;
}

const CHAIRMAN_SYSTEM_PROMPT = `You are the chairman of a council of AI assistants. Your role is to synthesize the responses from multiple council members into a single, comprehensive, well-reasoned answer.

When synthesizing responses, you should:
1. Identify points of agreement among the council members
2. Address any contradictions or disagreements thoughtfully
3. Highlight the strongest insights from each response
4. Provide a clear, unified answer to the user's original question

Do not mention that you are a "chairman" or reference the council structure in your response. Simply provide the best synthesized answer as if you were directly responding to the user.`;

export function useCouncilStreaming(
  options: UseCouncilStreamingOptions
): UseCouncilStreamingReturn {
  // Phase 1: Council member state
  const [memberContents, setMemberContents] = useState<Map<string, string>>(new Map());
  const [memberStatuses, setMemberStatuses] = useState<Map<string, ComparisonResponse['status']>>(new Map());
  const [memberErrors, setMemberErrors] = useState<Map<string, string>>(new Map());

  // Phase 2: Chairman state
  const [chairmanContent, setChairmanContent] = useState('');
  const [chairmanStatus, setChairmanStatus] = useState<'idle' | 'pending' | 'streaming' | 'complete' | 'error'>('idle');
  const [chairmanError, setChairmanError] = useState<string | null>(null);

  // Overall state
  const [currentPhase, setCurrentPhase] = useState<CouncilPhase>('idle');
  const [isAnyStreaming, setIsAnyStreaming] = useState(false);

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const chairmanAbortRef = useRef<AbortController | null>(null);
  const { startStreaming: startContextStreaming, completeStreaming: completeContextStreaming } = useStreamingContext();

  // Sync streaming state with the global context for sidebar indicator
  useEffect(() => {
    if (!options.conversationId) return;

    if (isAnyStreaming) {
      startContextStreaming(options.conversationId);
    } else {
      completeContextStreaming(options.conversationId, options.isCurrentConversation);
    }
  }, [isAnyStreaming, options.conversationId, options.isCurrentConversation, startContextStreaming, completeContextStreaming]);

  const getModelKey = (model: ModelInfo) => `${model.provider}:${model.id}`;

  const updateMemberStatus = useCallback((modelKey: string, status: ComparisonResponse['status']) => {
    setMemberStatuses(prev => new Map(prev).set(modelKey, status));
  }, []);

  const updateMemberContent = useCallback((modelKey: string, chunk: string) => {
    setMemberContents(prev => {
      const next = new Map(prev);
      const current = next.get(modelKey) || '';
      next.set(modelKey, current + chunk);
      return next;
    });
  }, []);

  const updateMemberError = useCallback((modelKey: string, error: string) => {
    setMemberErrors(prev => new Map(prev).set(modelKey, error));
  }, []);

  const stopAll = useCallback(() => {
    // Stop all council members
    abortControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    abortControllersRef.current.clear();

    // Stop chairman
    if (chairmanAbortRef.current) {
      chairmanAbortRef.current.abort();
      chairmanAbortRef.current = null;
    }

    setIsAnyStreaming(false);
  }, []);

  const startCouncilStreaming = useCallback(async (
    userMessage: string,
    councilMembers: ModelInfo[],
    chairman: ModelInfo
  ): Promise<CouncilStreamingResult> => {
    // Reset all state
    setMemberContents(new Map());
    setMemberStatuses(new Map());
    setMemberErrors(new Map());
    setChairmanContent('');
    setChairmanStatus('idle');
    setChairmanError(null);
    setCurrentPhase('individual');
    setIsAnyStreaming(true);
    abortControllersRef.current.clear();
    chairmanAbortRef.current = null;

    // Initialize member statuses
    councilMembers.forEach(model => {
      const key = getModelKey(model);
      updateMemberStatus(key, 'pending');
    });

    // Create user message
    const newUserMessage: Message = {
      role: 'user',
      timestamp: new Date().toISOString(),
      content: userMessage,
    };

    const messages = [...options.existingMessages, newUserMessage];

    // ========== PHASE 1: Council Members ==========
    const memberPromises = councilMembers.map(async (model): Promise<ComparisonResponse> => {
      const modelKey = getModelKey(model);
      const provider = providerRegistry.getProvider(model.provider);

      if (!provider || !provider.isInitialized()) {
        updateMemberStatus(modelKey, 'error');
        const errorMsg = `Provider ${model.provider} not initialized`;
        updateMemberError(modelKey, errorMsg);
        return {
          provider: model.provider,
          model: model.id,
          content: '',
          status: 'error',
          error: errorMsg,
        };
      }

      const abortController = new AbortController();
      abortControllersRef.current.set(modelKey, abortController);

      try {
        updateMemberStatus(modelKey, 'streaming');

        const result = await provider.sendMessage(messages, {
          model: model.id,
          systemPrompt: options.systemPrompt,
          onChunk: (text) => updateMemberContent(modelKey, text),
          signal: abortController.signal,
        });

        updateMemberStatus(modelKey, 'complete');
        abortControllersRef.current.delete(modelKey);

        return {
          provider: model.provider,
          model: model.id,
          content: result.content,
          status: 'complete',
        };
      } catch (error: unknown) {
        abortControllersRef.current.delete(modelKey);

        if (error instanceof Error && error.name === 'AbortError') {
          updateMemberStatus(modelKey, 'complete');
          return {
            provider: model.provider,
            model: model.id,
            content: '',
            status: 'complete',
          };
        }

        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        updateMemberStatus(modelKey, 'error');
        updateMemberError(modelKey, errorMsg);

        return {
          provider: model.provider,
          model: model.id,
          content: '',
          status: 'error',
          error: errorMsg,
        };
      }
    });

    // Wait for all council members
    const memberResultsSettled = await Promise.allSettled(memberPromises);
    const memberResponses: ComparisonResponse[] = memberResultsSettled.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        provider: 'anthropic' as ProviderType,
        model: 'unknown',
        content: '',
        status: 'error' as const,
        error: 'Unexpected error',
      };
    });

    // ========== PHASE 2: Chairman Synthesis ==========
    setCurrentPhase('synthesis');
    setChairmanStatus('pending');

    // Build the chairman prompt with all responses
    const chairmanProvider = providerRegistry.getProvider(chairman.provider);

    if (!chairmanProvider || !chairmanProvider.isInitialized()) {
      const errorMsg = `Chairman provider ${chairman.provider} not initialized`;
      setChairmanStatus('error');
      setChairmanError(errorMsg);
      setCurrentPhase('complete');
      setIsAnyStreaming(false);

      return {
        memberResponses,
        chairmanResponse: {
          provider: chairman.provider,
          model: chairman.id,
          content: '',
          status: 'error',
          error: errorMsg,
        },
      };
    }

    // Build context with all council responses
    const councilResponsesText = memberResponses
      .filter(r => r.status === 'complete' && r.content)
      .map((r, index) => {
        const modelInfo = councilMembers[index];
        const modelName = modelInfo?.name || `${r.provider}/${r.model}`;
        return `=== Response from ${modelName} ===\n${r.content}`;
      })
      .join('\n\n');

    const chairmanUserMessage = `USER'S ORIGINAL QUESTION:
${userMessage}

COUNCIL MEMBER RESPONSES:

${councilResponsesText}

Please synthesize these responses into a comprehensive final answer.`;

    const chairmanMessages: Message[] = [
      {
        role: 'user',
        timestamp: new Date().toISOString(),
        content: chairmanUserMessage,
      },
    ];

    chairmanAbortRef.current = new AbortController();

    try {
      setChairmanStatus('streaming');

      const chairmanResult = await chairmanProvider.sendMessage(chairmanMessages, {
        model: chairman.id,
        systemPrompt: CHAIRMAN_SYSTEM_PROMPT,
        onChunk: (text) => setChairmanContent(prev => prev + text),
        signal: chairmanAbortRef.current.signal,
      });

      setChairmanStatus('complete');
      setCurrentPhase('complete');
      setIsAnyStreaming(false);
      chairmanAbortRef.current = null;

      return {
        memberResponses,
        chairmanResponse: {
          provider: chairman.provider,
          model: chairman.id,
          content: chairmanResult.content,
          status: 'complete',
        },
      };
    } catch (error: unknown) {
      chairmanAbortRef.current = null;

      if (error instanceof Error && error.name === 'AbortError') {
        setChairmanStatus('complete');
        setCurrentPhase('complete');
        setIsAnyStreaming(false);

        return {
          memberResponses,
          chairmanResponse: {
            provider: chairman.provider,
            model: chairman.id,
            content: '',
            status: 'complete',
          },
        };
      }

      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setChairmanStatus('error');
      setChairmanError(errorMsg);
      setCurrentPhase('complete');
      setIsAnyStreaming(false);

      return {
        memberResponses,
        chairmanResponse: {
          provider: chairman.provider,
          model: chairman.id,
          content: '',
          status: 'error',
          error: errorMsg,
        },
      };
    }
  }, [options.existingMessages, options.systemPrompt, updateMemberStatus, updateMemberContent, updateMemberError]);

  return {
    memberContents,
    memberStatuses,
    memberErrors,
    chairmanContent,
    chairmanStatus,
    chairmanError,
    currentPhase,
    startCouncilStreaming,
    stopAll,
    isAnyStreaming,
  };
}
