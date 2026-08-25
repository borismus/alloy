import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
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

const attachButton = () => screen.getByRole('button', { name: /Attach image|can't accept images/ });

describe('image attachment gating', () => {
  it('disables attaching when the model cannot accept images', () => {
    renderForm(TEXT_ONLY.key);
    const button = attachButton();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toContain("can't accept images");
  });

  it('allows attaching when the model supports images', () => {
    renderForm(VISION.key);
    expect((attachButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('treats an absent supportsImages flag as supported', () => {
    // Regression guard: the wire omits the field when true, so a truthiness
    // check here would wrongly block every normal model.
    expect(VISION.supportsImages).toBeUndefined();
    renderForm(VISION.key);
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
      ref.current?.addImages([
        { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', preview: 'blob:preview' },
      ]);
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
    expect(warning.textContent).toContain("can't accept images");
    expect(warning.textContent).toContain('Text-only test model');
  });
});
