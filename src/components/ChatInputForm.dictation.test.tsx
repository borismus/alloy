import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInputForm } from './ChatInputForm';
import type { ModelInfo } from '../types';

const dictationMock = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: null as any,
  state: 'idle',
  mode: null as string | null,
  start: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../hooks/useDictation', () => ({
  useDictation: (options: unknown) => {
    dictationMock.options = options;
    return {
      dictationState: dictationMock.state,
      dictationMode: dictationMock.mode,
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
    dictationMock.state = 'idle';
    dictationMock.mode = null;
    dictationMock.start.mockReset();
    dictationMock.finish.mockReset();
    dictationMock.cancel.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('starts manual dictation on press and leaves the combined transcript to edit after stop', () => {
    const { onSubmit } = renderForm();
    const textarea = screen.getByPlaceholderText('Send a message...');
    const mic = screen.getByRole('button', { name: 'Start voice input' });
    fireEvent.change(textarea, { target: { value: 'Existing context' } });

    fireEvent.click(mic);
    expect(dictationMock.start).toHaveBeenCalledWith('manual');

    act(() => dictationMock.options.onTranscript('spoken words'));
    expect((textarea as HTMLTextAreaElement).value).toBe('Existing context spoken words');

    act(() => dictationMock.options.onEndpoint('spoken words'));
    // The mic only dictates; sending is the send button's job.
    expect(onSubmit).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe('Existing context spoken words');
  });

  it('uses held Space as push-to-talk without retaining its initial space', () => {
    renderForm();
    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.change(textarea, { target: { value: 'Existing context' } });

    fireEvent.keyDown(textarea, { key: ' ', code: 'Space' });
    // fireEvent does not perform the browser's default text insertion, so
    // reproduce the onChange that follows a real Space keydown.
    fireEvent.change(textarea, { target: { value: 'Existing context ' } });
    act(() => vi.advanceTimersByTime(450));

    expect(dictationMock.start).toHaveBeenCalledWith('push-to-talk');
    expect((textarea as HTMLTextAreaElement).value).toBe('Existing context');
    expect(dictationMock.finish).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    expect(dictationMock.finish).toHaveBeenCalledTimes(1);
  });

  it('sends when push-to-talk finishes', () => {
    const { onSubmit } = renderForm();
    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.change(textarea, { target: { value: 'Existing context' } });
    fireEvent.keyDown(textarea, { key: ' ', code: 'Space' });
    fireEvent.change(textarea, { target: { value: 'Existing context ' } });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });

    act(() => dictationMock.options.onEndpoint('spoken'));
    expect(onSubmit).toHaveBeenCalledWith('Existing context spoken', []);
  });

  it('send during dictation finishes recording instead of sending the partial text', () => {
    dictationMock.state = 'recording';
    dictationMock.mode = 'manual';
    const { onSubmit } = renderForm();
    act(() => dictationMock.options.onTranscript('partial'));

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(dictationMock.finish).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => dictationMock.options.onEndpoint('partial and the rest'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('partial and the rest', []);
  });

  it('uses the microphone as a stop toggle while manual dictation is active', () => {
    dictationMock.state = 'recording';
    dictationMock.mode = 'manual';
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Stop voice input' }));

    expect(dictationMock.finish).toHaveBeenCalledTimes(1);
    expect(dictationMock.start).not.toHaveBeenCalled();
  });

  it('retains the final transcript when the parent rejects voice submission', () => {
    dictationMock.state = 'recording';
    dictationMock.mode = 'manual';
    const onSubmit = vi.fn(() => false);
    renderForm(onSubmit);
    const textarea = screen.getByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
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
