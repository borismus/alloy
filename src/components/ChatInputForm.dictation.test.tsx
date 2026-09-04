import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInputForm } from './ChatInputForm';
import type { ModelInfo } from '../types';

const dictationMock = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: null as any,
  start: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../hooks/useDictation', () => ({
  useDictation: (options: unknown) => {
    dictationMock.options = options;
    return {
      dictationState: 'idle',
      dictationMode: null,
      error: null,
      startDictation: dictationMock.start,
      finishDictation: dictationMock.finish,
      cancelDictation: dictationMock.cancel,
      toggleDictation: vi.fn(),
    };
  },
}));

const MODEL: ModelInfo = { key: 'mlx/test', name: 'Test model', provider: 'mlx' };

function renderForm(onSubmit = vi.fn(() => true)) {
  render(
    <ChatInputForm
      onSubmit={onSubmit}
      onStop={vi.fn()}
      isStreaming={false}
      model={MODEL.key}
      onModelChange={vi.fn()}
      availableModels={[MODEL]}
      sonioxApiKey="soniox-key"
    />,
  );
  return { onSubmit };
}

describe('ChatInputForm voice input', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dictationMock.options = null;
    dictationMock.start.mockReset();
    dictationMock.finish.mockReset();
    dictationMock.cancel.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('starts one-shot dictation on a short press and submits the combined transcript', () => {
    const { onSubmit } = renderForm();
    const textarea = screen.getByPlaceholderText('Send a message...');
    const mic = screen.getByRole('button', { name: 'Start voice input' });
    fireEvent.change(textarea, { target: { value: 'Existing context' } });

    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 });
    expect(dictationMock.start).toHaveBeenCalledWith('one-shot');

    act(() => dictationMock.options.onTranscript('spoken words'));
    expect((textarea as HTMLTextAreaElement).value).toBe('Existing context spoken words');

    act(() => dictationMock.options.onEndpoint('spoken words'));
    expect(onSubmit).toHaveBeenCalledWith('Existing context spoken words', []);
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('uses release as the endpoint after a long press', () => {
    renderForm();
    const mic = screen.getByRole('button', { name: 'Start voice input' });

    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(450));
    expect(dictationMock.start).toHaveBeenCalledWith('push-to-talk');
    expect(dictationMock.finish).not.toHaveBeenCalled();

    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 });
    expect(dictationMock.finish).toHaveBeenCalledTimes(1);
  });

  it('retains the final transcript when the parent rejects voice submission', () => {
    const onSubmit = vi.fn(() => false);
    renderForm(onSubmit);
    const textarea = screen.getByPlaceholderText('Send a message...');

    act(() => dictationMock.options.onEndpoint('do not lose this'));

    expect(onSubmit).toHaveBeenCalledWith('do not lose this', []);
    expect((textarea as HTMLTextAreaElement).value).toBe('do not lose this');
  });

  it('hides voice input when Soniox is not configured', () => {
    render(
      <ChatInputForm
        onSubmit={vi.fn(() => true)}
        onStop={vi.fn()}
        isStreaming={false}
        model={MODEL.key}
        onModelChange={vi.fn()}
        availableModels={[MODEL]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Start voice input' })).toBeNull();
  });
});
