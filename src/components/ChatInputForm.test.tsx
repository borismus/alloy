import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { ChatInputForm, type ChatInputFormHandle } from './ChatInputForm';
import type { ModelInfo } from '../types';

const VISION: ModelInfo = { key: 'anthropic/claude', name: 'Claude Sonnet 5', provider: 'anthropic' };
// The backend omits `supportsImages` when true, so only an explicit false blocks.
const TEXT_ONLY: ModelInfo = {
  // Synthetic capability fixture: both subscription CLI adapters now support
  // images, but the composer must remain safe for any future text-only model.
  key: 'test-text/model',
  name: 'Text-only test model',
  provider: 'test-text',
  supportsImages: false,
};

function renderForm(model: string, ref?: React.Ref<ChatInputFormHandle>) {
  return render(
    <ChatInputForm
      ref={ref}
      onSubmit={vi.fn()}
      onStop={vi.fn()}
      isStreaming={false}
      model={model}
      onModelChange={vi.fn()}
      availableModels={[VISION, TEXT_ONLY]}
    />
  );
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  // jsdom/happy-dom don't implement object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const attachButton = () => screen.getByRole('button', { name: 'Attach file' });

describe('message submission', () => {
  it('keeps composed text when the parent cannot accept the send', () => {
    const onSubmit = vi.fn(() => false);
    render(
      <ChatInputForm
        onSubmit={onSubmit}
        onStop={vi.fn()}
        isStreaming={false}
        model={VISION.key}
        onModelChange={vi.fn()}
        availableModels={[VISION]}
      />
    );

    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.change(textarea, { target: { value: 'Do not lose this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSubmit).toHaveBeenCalledWith('Do not lose this draft', []);
    expect((textarea as HTMLTextAreaElement).value).toBe('Do not lose this draft');
  });
});

const PNG = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', name: 'shot.png', preview: 'blob:preview' };
const PDF = { data: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', name: 'paper.pdf' };
const MD = { data: new Uint8Array([1, 2, 3]), mimeType: 'text/markdown', name: 'notes.md' };

describe('attachment gating', () => {
  it('keeps attaching available on text-only models, since Markdown always works', () => {
    renderForm(TEXT_ONLY.key);
    expect((attachButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses the same shared 48px control size for attach and send', () => {
    renderForm(VISION.key);
    const attachClasses = new Set(attachButton().className.split(' '));
    const sendClasses = screen.getByRole('button', { name: 'Send message' }).className.split(' ');
    // Root + composer classes are shared; only their visual variants differ.
    expect(sendClasses.filter(className => attachClasses.has(className)).length).toBeGreaterThanOrEqual(2);
  });

  it('warns instead of silently dropping images already attached', () => {
    // Reachable by attaching on a vision model then switching to a text-only
    // one, which previously sent the text alone with no indication.
    const ref = createRef<ChatInputFormHandle>();
    const { rerender } = renderForm(VISION.key, ref);

    act(() => {
      ref.current?.addAttachments([PNG]);
    });
    expect(screen.queryByRole('status')).toBeNull();

    rerender(
      <ChatInputForm
        ref={ref}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        isStreaming={false}
        model={TEXT_ONLY.key}
        onModelChange={vi.fn()}
        availableModels={[VISION, TEXT_ONLY]}
      />
    );

    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain("can't read images");
    expect(warning.textContent).toContain('Text-only test model');
  });

  it('warns about PDFs unless the model explicitly reads them', () => {
    // Absent `supportsPdfs` means unsupported — the opposite of images.
    const ref = createRef<ChatInputFormHandle>();
    renderForm(VISION.key, ref);
    act(() => {
      ref.current?.addAttachments([PDF]);
    });
    expect(screen.getByRole('status').textContent).toContain("can't read PDFs");
  });

  it('accepts PDFs on models that read them natively', () => {
    const ref = createRef<ChatInputFormHandle>();
    render(
      <ChatInputForm
        ref={ref}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        isStreaming={false}
        model={VISION.key}
        onModelChange={vi.fn()}
        availableModels={[{ ...VISION, supportsPdfs: true }]}
      />
    );
    act(() => {
      ref.current?.addAttachments([PDF]);
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('paper.pdf')).toBeTruthy();
  });

  it('warns when a PDF exceeds the model\'s delivery limit', () => {
    const ref = createRef<ChatInputFormHandle>();
    render(
      <ChatInputForm
        ref={ref}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        isStreaming={false}
        model={VISION.key}
        onModelChange={vi.fn()}
        availableModels={[{ ...VISION, supportsPdfs: true, maxPdfBytes: 2 }]}
      />
    );
    act(() => {
      ref.current?.addAttachments([{ ...PDF, data: new Uint8Array(3) }]);
    });
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain('paper.pdf');
    expect(warning.textContent).toContain('only receives PDFs up to');
  });

  it('does not warn about a PDF within the limit', () => {
    const ref = createRef<ChatInputFormHandle>();
    render(
      <ChatInputForm
        ref={ref}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        isStreaming={false}
        model={VISION.key}
        onModelChange={vi.fn()}
        availableModels={[{ ...VISION, supportsPdfs: true, maxPdfBytes: 3 }]}
      />
    );
    act(() => {
      ref.current?.addAttachments([{ ...PDF, data: new Uint8Array(3) }]);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never warns about Markdown, which is sent as text', () => {
    const ref = createRef<ChatInputFormHandle>();
    renderForm(TEXT_ONLY.key, ref);
    act(() => {
      ref.current?.addAttachments([MD]);
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('notes.md')).toBeTruthy();
  });
});
