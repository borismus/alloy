import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInterface } from './ChatInterface';
import { StreamingProvider } from '../contexts/StreamingContext';
import { MessageQueueProvider } from '../contexts/MessageQueueContext';
import type { Attachment, Conversation } from '../types';

const conversation: Conversation = {
  id: 'conv-1',
  model: 'openrouter/anthropic/claude-sonnet-5',
  created: '2024-01-01T10:00:00Z',
  updated: '2024-01-01T10:00:00Z',
  messages: [],
  messagesLoaded: true,
};

interface Deferred {
  resolve: (a: Attachment) => void;
  reject: (e: Error) => void;
}

function renderChat(overrides: {
  onSaveImage: (id: string, data: Uint8Array, mime: string) => Promise<Attachment>;
  onSendMessage?: () => Promise<void>;
}) {
  const onSendMessage = overrides.onSendMessage ?? vi.fn(async () => {});
  render(
    <StreamingProvider>
      <MessageQueueProvider>
        <ChatInterface
          conversation={conversation}
          onSendMessage={onSendMessage}
          onSaveImage={overrides.onSaveImage}
          loadImageAsBase64={vi.fn(async () => ({ base64: '', mimeType: 'image/png' }))}
          hasProvider
          onModelChange={vi.fn()}
          availableModels={[]}
        />
      </MessageQueueProvider>
    </StreamingProvider>,
  );
  return { onSendMessage };
}

/** Paste an image into the composer (the only pending-image path in jsdom). */
async function pasteImage(name = 'shot.png') {
  const textarea = screen.getByPlaceholderText('Send a message...');
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  const before = document.querySelectorAll('.pending-image').length;
  fireEvent.paste(textarea, {
    clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] },
  });
  // The paste handler reads the blob asynchronously before queuing the image.
  await waitFor(() =>
    expect(document.querySelectorAll('.pending-image').length).toBe(before + 1),
  );
}

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(Object.create(URL), {
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  }));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatInterface image preparation feedback', () => {
  it('shows one indicator while multiple images persist, then hands off to streaming', async () => {
    const deferreds: Deferred[] = [];
    const onSaveImage = vi.fn(
      () => new Promise<Attachment>((resolve, reject) => deferreds.push({ resolve, reject })),
    );
    const { onSendMessage } = renderChat({ onSaveImage });

    await pasteImage('one.png');
    await pasteImage('two.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Indicator appears immediately, before any save resolves; no model call yet.
    const indicator = await screen.findByRole('status');
    expect(indicator.textContent).toContain('Preparing images…');
    expect(onSendMessage).not.toHaveBeenCalled();

    // Still exactly one indicator while the saves proceed one by one.
    deferreds[0].resolve({ type: 'image', path: 'attachments/one.png', mimeType: 'image/png' });
    await waitFor(() => expect(onSaveImage).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(onSendMessage).not.toHaveBeenCalled();

    // Final save resolves: the indicator yields to the streaming state.
    deferreds[1].resolve({ type: 'image', path: 'attachments/two.png', mimeType: 'image/png' });
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('queues a message submitted during preparation instead of racing it', async () => {
    const deferreds: Deferred[] = [];
    const onSaveImage = vi.fn(
      () => new Promise<Attachment>((resolve, reject) => deferreds.push({ resolve, reject })),
    );
    const { onSendMessage } = renderChat({ onSaveImage });

    await pasteImage();
    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByRole('status');

    // A second submission while preparing must be queued, not sent concurrently.
    fireEvent.change(textarea, { target: { value: 'follow-up while preparing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('follow-up while preparing')).toBeTruthy();
    expect(onSaveImage).toHaveBeenCalledTimes(1);

    deferreds[0].resolve({ type: 'image', path: 'attachments/one.png', mimeType: 'image/png' });
    await waitFor(() => expect(onSendMessage).toHaveBeenCalled());
  });

  it('clears the indicator when an image save fails', async () => {
    const onSaveImage = vi.fn(async () => {
      throw new Error('disk full');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onSendMessage } = renderChat({ onSaveImage });

    await pasteImage();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save image attachments'),
      expect.any(Error),
    );
  });
});
