import { useState, useRef, useCallback, useEffect } from 'react';
import { SonioxClient, type RecorderState } from '@soniox/speech-to-text-web';

export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping';
export type DictationMode = 'continuous' | 'one-shot' | 'push-to-talk';

interface UseDictationOptions {
  apiKey: string | undefined;
  onTranscript: (text: string) => void;
  onEndpoint: (finalText: string) => void;
}

interface UseDictationReturn {
  dictationState: DictationState;
  dictationMode: DictationMode | null;
  error: string | null;
  startDictation: (mode?: DictationMode) => void;
  finishDictation: () => void;
  toggleDictation: () => void;
  cancelDictation: () => void;
}

// Build text from tokens, inserting "Speaker {id}: " on new lines when the speaker changes.
// First speaker gets no label; labels only appear once a second speaker is detected.
function tokensToText(
  tokens: Array<{ text: string; speaker?: string }>,
  speakerRef: { current: string | null },
  hasTextBefore: boolean
): string {
  let text = '';
  for (const token of tokens) {
    if (token.speaker && token.speaker !== speakerRef.current) {
      if (speakerRef.current !== null) {
        const prefix = (hasTextBefore || text) ? '\n' : '';
        text += `${prefix}Speaker ${token.speaker}: `;
      }
      speakerRef.current = token.speaker;
    }
    text += token.text;
  }
  return text;
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
  const [dictationMode, setDictationMode] = useState<DictationMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<SonioxClient | null>(null);
  const modeRef = useRef<DictationMode | null>(null);
  const finishRequestedRef = useRef(false);
  const endpointSubmittedRef = useRef(false);
  const latestTextRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  const onEndpointRef = useRef(onEndpoint);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onEndpointRef.current = onEndpoint;
  }, [onTranscript, onEndpoint]);

  // Accumulate finalized tokens that Soniox drops from its rolling window.
  // Without this, long speech gets truncated as older final tokens fall out
  // of subsequent onPartialResult responses.
  const accFinalTextRef = useRef('');
  const accFinalEndMsRef = useRef(-1);
  // Track current speaker for diarization — insert line breaks on speaker changes
  const accSpeakerRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.cancel();
      clientRef.current = null;
    };
  }, []);

  const startDictation = useCallback((mode: DictationMode = 'continuous') => {
    if (!apiKey) {
      setError('Soniox API key not configured. Add sonioxApiKey to config.yaml.');
      return;
    }
    if (!SonioxClient.isSupported) {
      setError('Voice input requires microphone access in the Alloy app or a secure browser connection.');
      return;
    }
    if (clientRef.current) return;

    setError(null);
    setDictationState('starting');
    setDictationMode(mode);
    modeRef.current = mode;
    finishRequestedRef.current = false;
    endpointSubmittedRef.current = false;
    latestTextRef.current = '';

    // Reset accumulators for new session
    accFinalTextRef.current = '';
    accFinalEndMsRef.current = -1;
    accSpeakerRef.current = null;

    const client = new SonioxClient({
      apiKey,
      onStateChange: ({ newState }) => {
        setDictationState(mapState(newState));
        // Push-to-talk can be released while microphone permission or the
        // websocket is still starting. Honor that release as soon as Soniox
        // reaches a state where stop() can finalize the buffered audio.
        if (newState === 'Running' && finishRequestedRef.current) {
          clientRef.current?.stop();
        }
      },
      onPartialResult: (result) => {
        // Stopping a one-shot session can produce trailing final-result events.
        // The turn was already accepted at <end>; never put it back into the
        // freshly-cleared composer or submit it twice.
        if (modeRef.current === 'one-shot' && endpointSubmittedRef.current) return;

        const tokens = result.tokens ?? [];
        const hasEndpoint = tokens.some(t => t.text === '<end>');

        if (hasEndpoint) {
          // Endpoint response re-emits tokens as final, followed by <end>.
          // Combine with our accumulator in case older tokens were dropped.
          const contentTokens = tokens.filter(t => t.text !== '<end>');
          const newTokens = contentTokens.filter(t =>
            (t.start_ms ?? 0) > accFinalEndMsRef.current
          );
          const fullText = accFinalTextRef.current + tokensToText(newTokens, accSpeakerRef, !!accFinalTextRef.current);
          latestTextRef.current = fullText;
          console.log('[Dictation] <end>, fullText:', JSON.stringify(fullText));
          onTranscriptRef.current(fullText);

          if (modeRef.current !== 'push-to-talk') {
            onEndpointRef.current(fullText);
            if (modeRef.current === 'one-shot') {
              endpointSubmittedRef.current = true;
              finishRequestedRef.current = true;
              clientRef.current?.stop();
            }

            // Continuous Riff dictation treats each endpoint as a new segment.
            accFinalTextRef.current = '';
            accFinalEndMsRef.current = -1;
            latestTextRef.current = '';
          }
        } else {
          // Streaming partial — accumulate final tokens, show accumulated + non-final
          const finalTokens = tokens.filter(t => t.is_final);
          const nonFinalTokens = tokens.filter(t => !t.is_final);

          // Add newly finalized tokens beyond our accumulation point
          const newFinalTokens = finalTokens.filter(t =>
            (t.start_ms ?? 0) > accFinalEndMsRef.current
          );
          if (newFinalTokens.length > 0) {
            accFinalTextRef.current += tokensToText(newFinalTokens, accSpeakerRef, !!accFinalTextRef.current);
            const last = newFinalTokens[newFinalTokens.length - 1];
            accFinalEndMsRef.current = last.end_ms ?? last.start_ms ?? accFinalEndMsRef.current;
          }

          // Use a temporary speaker copy so non-final tokens don't permanently advance speaker state
          const tempSpeaker = { current: accSpeakerRef.current };
          const displayText = accFinalTextRef.current + tokensToText(nonFinalTokens, tempSpeaker, !!accFinalTextRef.current);
          // A terminal Soniox packet can contain no tokens. Keep the last
          // visible partial so push-to-talk release still submits what the user
          // just dictated instead of replacing it with an empty string.
          if (displayText) {
            latestTextRef.current = displayText;
            onTranscriptRef.current(displayText);
          }
        }
      },
      onError: (_status, message) => {
        console.error('[Dictation] error:', _status, message);
        setError(message || 'Dictation error');
        setDictationState('idle');
        setDictationMode(null);
        modeRef.current = null;
        clientRef.current = null;
      },
      onFinished: () => {
        const mode = modeRef.current;
        const finalText = latestTextRef.current;
        if (
          (mode === 'one-shot' || mode === 'push-to-talk')
          && !endpointSubmittedRef.current
          && finalText.trim()
        ) {
          endpointSubmittedRef.current = true;
          onTranscriptRef.current(finalText);
          onEndpointRef.current(finalText);
        }
        setDictationState('idle');
        setDictationMode(null);
        modeRef.current = null;
        finishRequestedRef.current = false;
        clientRef.current = null;
      },
    });

    clientRef.current = client;

    void client.start({
      model: 'stt-rt-preview',
      languageHints: ['en'],
      enableEndpointDetection: mode !== 'push-to-talk',
      enableSpeakerDiarization: true,
    });
  }, [apiKey]);

  const finishDictation = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;

    finishRequestedRef.current = true;
    if (client.state === 'Running') {
      client.stop();
    }
  }, []);

  const cancelDictation = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.cancel();
      clientRef.current = null;
    }
    finishRequestedRef.current = false;
    modeRef.current = null;
    setDictationState('idle');
    setDictationMode(null);
  }, []);

  const toggleDictation = useCallback(() => {
    if (dictationState === 'idle') {
      startDictation('continuous');
    } else if (dictationState === 'recording') {
      finishDictation();
    }
  }, [dictationState, startDictation, finishDictation]);

  return {
    dictationState,
    dictationMode,
    error,
    startDictation,
    finishDictation,
    toggleDictation,
    cancelDictation,
  };
}
