import { useState, useRef, useCallback, useEffect } from 'react';
import { ModelInfo, Message, ComparisonResponse, ToolUse, getProviderFromModel, getModelIdFromModel } from '../types';
import { providerRegistry } from '../services/providers/registry';
import { useStreamingContext } from '../contexts/StreamingContext';
import { executeWithTools } from '../services/tools/executor';
import { BUILTIN_TOOLS } from '../types/tools';

interface UseComparisonStreamingOptions {
  conversationId: string | null;
  isCurrentConversation: boolean;
  systemPrompt?: string;
  existingMessages: Message[];
}

interface UseComparisonStreamingReturn {
  streamingContents: Map<string, string>;
  streamingToolUses: Map<string, ToolUse[]>;
  statuses: Map<string, ComparisonResponse['status']>;
  errors: Map<string, string>;
  startStreaming: (userMessage: string, models: ModelInfo[]) => Promise<ComparisonResponse[]>;
  stopModel: (modelId: string) => void;
  stopAll: () => void;
  isAnyStreaming: boolean;
}

export function useComparisonStreaming(
  options: UseComparisonStreamingOptions
): UseComparisonStreamingReturn {
  const [streamingContents, setStreamingContents] = useState<Map<string, string>>(new Map());
  const [streamingToolUses, setStreamingToolUses] = useState<Map<string, ToolUse[]>>(new Map());
  const [statuses, setStatuses] = useState<Map<string, ComparisonResponse['status']>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [isAnyStreaming, setIsAnyStreaming] = useState(false);

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
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

  // Use model.key directly for map lookups

  const updateStatus = useCallback((modelKey: string, status: ComparisonResponse['status']) => {
    setStatuses(prev => new Map(prev).set(modelKey, status));
  }, []);

  const updateContent = useCallback((modelKey: string, chunk: string) => {
    setStreamingContents(prev => {
      const next = new Map(prev);
      const current = next.get(modelKey) || '';
      next.set(modelKey, current + chunk);
      return next;
    });
  }, []);

  const updateError = useCallback((modelKey: string, error: string) => {
    setErrors(prev => new Map(prev).set(modelKey, error));
  }, []);

  const addToolUse = useCallback((modelKey: string, toolUse: ToolUse) => {
    setStreamingToolUses(prev => {
      const next = new Map(prev);
      const current = next.get(modelKey) || [];
      next.set(modelKey, [...current, toolUse]);
      return next;
    });
  }, []);

  const stopModel = useCallback((modelId: string) => {
    const controller = abortControllersRef.current.get(modelId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(modelId);
    }
  }, []);

  const stopAll = useCallback(() => {
    abortControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    abortControllersRef.current.clear();
  }, []);

  const startStreaming = useCallback(async (
    userMessage: string,
    models: ModelInfo[]
  ): Promise<ComparisonResponse[]> => {
    // Reset state
    setStreamingContents(new Map());
    setStreamingToolUses(new Map());
    setStatuses(new Map());
    setErrors(new Map());
    setIsAnyStreaming(true);
    abortControllersRef.current.clear();

    // Initialize statuses
    models.forEach(model => {
      updateStatus(model.key, 'pending');
    });

    // Create user message
    const newUserMessage: Message = {
      role: 'user',
      timestamp: new Date().toISOString(),
      content: userMessage,
    };

    const messages = [...options.existingMessages, newUserMessage];

    // Start all streams in parallel
    const responsePromises = models.map(async (model): Promise<ComparisonResponse> => {
      const modelKey = model.key;
      const providerType = getProviderFromModel(model.key);
      const modelId = getModelIdFromModel(model.key);
      const provider = providerRegistry.getProvider(providerType);

      if (!provider || !provider.isInitialized()) {
        updateStatus(modelKey, 'error');
        const errorMsg = `Provider ${providerType} not initialized`;
        updateError(modelKey, errorMsg);
        return {
          model: model.key,
          content: '',
          status: 'error',
          error: errorMsg,
        };
      }

      const abortController = new AbortController();
      abortControllersRef.current.set(modelKey, abortController);

      try {
        updateStatus(modelKey, 'streaming');

        const result = await executeWithTools(provider, messages, modelId, {
          maxIterations: 10,
          onChunk: (text) => updateContent(modelKey, text),
          onToolUse: (toolUse) => addToolUse(modelKey, toolUse),
          signal: abortController.signal,
          systemPrompt: options.systemPrompt,
          tools: BUILTIN_TOOLS,
        });

        updateStatus(modelKey, 'complete');
        abortControllersRef.current.delete(modelKey);

        return {
          model: model.key,
          content: result.finalContent,
          status: 'complete',
          toolUse: result.allToolUses,
          skillUse: result.skillUses,
        };
      } catch (error: unknown) {
        abortControllersRef.current.delete(modelKey);

        if (error instanceof Error && error.name === 'AbortError') {
          // User cancelled - keep partial content
          updateStatus(modelKey, 'complete');
          return {
            model: model.key,
            content: '', // Partial content is in streamingContents
            status: 'complete',
          };
        }

        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        updateStatus(modelKey, 'error');
        updateError(modelKey, errorMsg);

        return {
          model: model.key,
          content: '',
          status: 'error',
          error: errorMsg,
        };
      }
    });

    // Wait for all to complete (using allSettled for fault tolerance)
    const results = await Promise.allSettled(responsePromises);
    setIsAnyStreaming(false);

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // This shouldn't happen since we handle errors inside, but just in case
      return {
        model: 'anthropic/unknown',
        content: '',
        status: 'error' as const,
        error: 'Unexpected error',
      };
    });
  }, [options.existingMessages, options.systemPrompt, updateStatus, updateContent, updateError, addToolUse]);

  return {
    streamingContents,
    streamingToolUses,
    statuses,
    errors,
    startStreaming,
    stopModel,
    stopAll,
    isAnyStreaming,
  };
}
