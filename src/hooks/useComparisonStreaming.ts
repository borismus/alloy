import { useState, useRef, useCallback } from 'react';
import { ModelInfo, Message, ComparisonResponse, ProviderType } from '../types';
import { providerRegistry } from '../services/providers/registry';

interface UseComparisonStreamingOptions {
  systemPrompt?: string;
  existingMessages: Message[];
}

interface UseComparisonStreamingReturn {
  streamingContents: Map<string, string>;
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
  const [statuses, setStatuses] = useState<Map<string, ComparisonResponse['status']>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [isAnyStreaming, setIsAnyStreaming] = useState(false);

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const getModelKey = (model: ModelInfo) => `${model.provider}:${model.id}`;

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
    setStatuses(new Map());
    setErrors(new Map());
    setIsAnyStreaming(true);
    abortControllersRef.current.clear();

    // Initialize statuses
    models.forEach(model => {
      const key = getModelKey(model);
      updateStatus(key, 'pending');
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
      const modelKey = getModelKey(model);
      const provider = providerRegistry.getProvider(model.provider);

      if (!provider || !provider.isInitialized()) {
        updateStatus(modelKey, 'error');
        const errorMsg = `Provider ${model.provider} not initialized`;
        updateError(modelKey, errorMsg);
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
        updateStatus(modelKey, 'streaming');

        const response = await provider.sendMessage(messages, {
          model: model.id,
          systemPrompt: options.systemPrompt,
          onChunk: (text) => updateContent(modelKey, text),
          signal: abortController.signal,
        });

        updateStatus(modelKey, 'complete');
        abortControllersRef.current.delete(modelKey);

        return {
          provider: model.provider,
          model: model.id,
          content: response,
          status: 'complete',
        };
      } catch (error: unknown) {
        abortControllersRef.current.delete(modelKey);

        if (error instanceof Error && error.name === 'AbortError') {
          // User cancelled - keep partial content
          updateStatus(modelKey, 'complete');
          return {
            provider: model.provider,
            model: model.id,
            content: '', // Partial content is in streamingContents
            status: 'complete',
          };
        }

        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        updateStatus(modelKey, 'error');
        updateError(modelKey, errorMsg);

        return {
          provider: model.provider,
          model: model.id,
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
        provider: 'anthropic' as ProviderType,
        model: 'unknown',
        content: '',
        status: 'error' as const,
        error: 'Unexpected error',
      };
    });
  }, [options.existingMessages, options.systemPrompt, updateStatus, updateContent, updateError]);

  return {
    streamingContents,
    statuses,
    errors,
    startStreaming,
    stopModel,
    stopAll,
    isAnyStreaming,
  };
}
