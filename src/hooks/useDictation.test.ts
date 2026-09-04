import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDictation } from './useDictation';

const sonioxMock = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instances: [] as any[],
}));

vi.mock('@soniox/speech-to-text-web', () => {
  class MockSonioxClient {
    static isSupported = true;
    state = 'Init';
    options: Record<string, (...args: never[]) => void>;
    audioOptions: Record<string, unknown> | null = null;
    start = vi.fn(async (options: Record<string, unknown>) => {
      this.audioOptions = options;
    });
    stop = vi.fn();
    cancel = vi.fn();

    constructor(options: Record<string, (...args: never[]) => void>) {
      this.options = options;
      sonioxMock.instances.push(this);
    }

    emitState(newState: string) {
      const oldState = this.state;
      this.state = newState;
      this.options.onStateChange?.({ oldState, newState } as never);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitTokens(tokens: any[]) {
      this.options.onPartialResult?.({ tokens } as never);
    }

    finish() {
      this.state = 'Finished';
      this.options.onFinished?.();
    }
  }

  return { SonioxClient: MockSonioxClient };
});

function token(text: string, start: number, isFinal = true) {
  return {
    text,
    start_ms: start,
    end_ms: start + 10,
    confidence: 1,
    is_final: isFinal,
  };
}

describe('useDictation modes', () => {
  beforeEach(() => {
    sonioxMock.instances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps Riff continuous mode running after an automatic endpoint', () => {
    const onTranscript = vi.fn();
    const onEndpoint = vi.fn();
    const { result } = renderHook(() => useDictation({ apiKey: 'key', onTranscript, onEndpoint }));

    act(() => result.current.startDictation('continuous'));
    const client = sonioxMock.instances[0];
    expect(client.audioOptions.enableEndpointDetection).toBe(true);

    act(() => client.emitTokens([token('hello', 0), token('<end>', 10)]));

    expect(onTranscript).toHaveBeenLastCalledWith('hello');
    expect(onEndpoint).toHaveBeenCalledWith('hello');
    expect(client.stop).not.toHaveBeenCalled();
  });

  it('submits one-shot speech once and stops after automatic endpoint detection', () => {
    const onTranscript = vi.fn();
    const onEndpoint = vi.fn();
    const { result } = renderHook(() => useDictation({
      apiKey: 'key',
      onTranscript,
      onEndpoint,
    }));

    act(() => result.current.startDictation('one-shot'));
    const client = sonioxMock.instances[0];
    act(() => client.emitState('Running'));
    act(() => client.emitTokens([token('one turn', 0), token('<end>', 10)]));

    expect(onEndpoint).toHaveBeenCalledTimes(1);
    expect(onEndpoint).toHaveBeenCalledWith('one turn');
    expect(client.stop).toHaveBeenCalledTimes(1);

    // Soniox may deliver a trailing result while stop() finishes. It must not
    // repopulate the composer after the accepted turn cleared it.
    act(() => client.emitTokens([token('one turn', 0)]));
    expect(onTranscript).toHaveBeenCalledTimes(1);

    act(() => client.finish());
    expect(onEndpoint).toHaveBeenCalledTimes(1);
  });

  it('disables automatic endpoints for push-to-talk and submits on release', () => {
    const onEndpoint = vi.fn();
    const { result } = renderHook(() => useDictation({
      apiKey: 'key',
      onTranscript: vi.fn(),
      onEndpoint,
    }));

    act(() => result.current.startDictation('push-to-talk'));
    const client = sonioxMock.instances[0];
    expect(client.audioOptions.enableEndpointDetection).toBe(false);
    act(() => client.emitState('Running'));

    // Even if the service emits an endpoint unexpectedly, holding the button
    // must not submit before release.
    act(() => client.emitTokens([token('hold me', 0), token('<end>', 10)]));
    expect(onEndpoint).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();

    act(() => result.current.finishDictation());
    expect(client.stop).toHaveBeenCalledTimes(1);
    act(() => client.finish());

    expect(onEndpoint).toHaveBeenCalledTimes(1);
    expect(onEndpoint).toHaveBeenCalledWith('hold me');
  });

  it('keeps the last push-to-talk partial across an empty terminal packet', () => {
    const onEndpoint = vi.fn();
    const { result } = renderHook(() => useDictation({
      apiKey: 'key',
      onTranscript: vi.fn(),
      onEndpoint,
    }));

    act(() => result.current.startDictation('push-to-talk'));
    const client = sonioxMock.instances[0];
    act(() => client.emitState('Running'));
    act(() => client.emitTokens([token('last partial', 0, false)]));
    act(() => result.current.finishDictation());

    // Soniox may finish with an empty token packet after the last partial.
    act(() => client.emitTokens([]));
    act(() => client.finish());

    expect(onEndpoint).toHaveBeenCalledTimes(1);
    expect(onEndpoint).toHaveBeenCalledWith('last partial');
  });

  it('honors a push-to-talk release that occurs while recording is starting', () => {
    const { result } = renderHook(() => useDictation({
      apiKey: 'key',
      onTranscript: vi.fn(),
      onEndpoint: vi.fn(),
    }));

    act(() => result.current.startDictation('push-to-talk'));
    const client = sonioxMock.instances[0];
    act(() => result.current.finishDictation());
    expect(client.stop).not.toHaveBeenCalled();

    act(() => client.emitState('Running'));
    expect(client.stop).toHaveBeenCalledTimes(1);
  });
});
