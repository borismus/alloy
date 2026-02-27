import { useState, useRef, useCallback, useEffect } from 'react';
import { SonioxClient, type RecorderState } from '@soniox/speech-to-text-web';

export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping';

interface UseDictationOptions {
  apiKey: string | undefined;
  onTranscript: (text: string) => void;
  onEndpoint: (finalText: string) => void;
}

interface UseDictationReturn {
  dictationState: DictationState;
  error: string | null;
  toggleDictation: () => void;
  cancelDictation: () => void;
}

function mapState(state: RecorderState): DictationState {
  switch (state) {
    case 'Init':
    case 'Finished':
    case 'Error':
    case 'Canceled':
      return 'idle';
    case 'RequestingMedia':
    case 'OpeningWebSocket':
      return 'starting';
    case 'Running':
      return 'recording';
    case 'FinishingProcessing':
      return 'stopping';
  }
}

export function useDictation({ apiKey, onTranscript, onEndpoint }: UseDictationOptions): UseDictationReturn {
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<SonioxClient | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onEndpointRef = useRef(onEndpoint);
  onEndpointRef.current = onEndpoint;

  // Accumulate finalized tokens that Soniox drops from its rolling window.
  // Without this, long speech gets truncated as older final tokens fall out
  // of subsequent onPartialResult responses.
  const accFinalTextRef = useRef('');
  const accFinalEndMsRef = useRef(-1);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.cancel();
      clientRef.current = null;
    };
  }, []);

  const startDictation = useCallback(() => {
    if (!apiKey) {
      setError('Soniox API key not configured. Add SONIOX_API_KEY to config.yaml.');
      return;
    }

    setError(null);
    setDictationState('starting');

    // Reset accumulators for new session
    accFinalTextRef.current = '';
    accFinalEndMsRef.current = -1;

    const client = new SonioxClient({
      apiKey,
      onStateChange: ({ newState }) => {
        setDictationState(mapState(newState));
      },
      onPartialResult: (result) => {
        const tokens = result.tokens ?? [];
        const hasEndpoint = tokens.some(t => t.text === '<end>');

        if (hasEndpoint) {
          // Endpoint response re-emits tokens as final, followed by <end>.
          // Combine with our accumulator in case older tokens were dropped.
          const contentTokens = tokens.filter(t => t.text !== '<end>');
          const newTokens = contentTokens.filter(t =>
            (t.start_ms ?? 0) > accFinalEndMsRef.current
          );
          const fullText = accFinalTextRef.current + newTokens.map(t => t.text).join('');
          console.log('[Dictation] <end>, fullText:', JSON.stringify(fullText));
          onTranscriptRef.current(fullText);
          onEndpointRef.current(fullText);

          // Reset accumulators for next segment
          accFinalTextRef.current = '';
          accFinalEndMsRef.current = -1;
        } else {
          // Streaming partial — accumulate final tokens, show accumulated + non-final
          const finalTokens = tokens.filter(t => t.is_final);
          const nonFinalTokens = tokens.filter(t => !t.is_final);

          // Add newly finalized tokens beyond our accumulation point
          const newFinalTokens = finalTokens.filter(t =>
            (t.start_ms ?? 0) > accFinalEndMsRef.current
          );
          if (newFinalTokens.length > 0) {
            accFinalTextRef.current += newFinalTokens.map(t => t.text).join('');
            const last = newFinalTokens[newFinalTokens.length - 1];
            accFinalEndMsRef.current = last.end_ms ?? last.start_ms ?? accFinalEndMsRef.current;
          }

          const displayText = accFinalTextRef.current + nonFinalTokens.map(t => t.text).join('');
          if (displayText) {
            onTranscriptRef.current(displayText);
          }
        }
      },
      onError: (_status, message) => {
        console.error('[Dictation] error:', _status, message);
        setError(message || 'Dictation error');
        setDictationState('idle');
        clientRef.current = null;
      },
      onFinished: () => {
        setDictationState('idle');
        clientRef.current = null;
      },
    });

    clientRef.current = client;

    client.start({
      model: 'stt-rt-preview',
      languageHints: ['en'],
      enableEndpointDetection: true,
    });
  }, [apiKey]);

  const stopDictation = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.stop();
    }
  }, []);

  const cancelDictation = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.cancel();
      clientRef.current = null;
      setDictationState('idle');
    }
  }, []);

  const toggleDictation = useCallback(() => {
    if (dictationState === 'idle') {
      startDictation();
    } else if (dictationState === 'recording') {
      stopDictation();
    }
  }, [dictationState, startDictation, stopDictation]);

  return {
    dictationState,
    error,
    toggleDictation,
    cancelDictation,
  };
}
