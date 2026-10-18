import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInterface } from './ChatInterface';
import { StreamingProvider, useStreamingContext } from '../contexts/StreamingContext';
import { MessageQueueProvider } from '../contexts/MessageQueueContext';
import type { Attachment, Conversation, Message } from '../types';

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
  onSaveAttachment: (id: string, data: Uint8Array, mime: string) => Promise<Attachment>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSendMessage?: (...args: any[]) => Promise<void>;
  conversation?: Conversation;
  onMobileBack?: () => void;
}) {
  const onSendMessage = overrides.onSendMessage ?? vi.fn(async () => {});
  render(
    <StreamingProvider>
      <MessageQueueProvider>
        <ChatInterface
          conversation={overrides.conversation ?? conversation}
          onSendMessage={onSendMessage}
          onSaveAttachment={overrides.onSaveAttachment}
          loadImageAsBase64={vi.fn(async () => ({ base64: '', mimeType: 'image/png' }))}
          hasProvider
          onModelChange={vi.fn()}
          availableModels={[]}
          onMobileBack={overrides.onMobileBack}
        />
      </MessageQueueProvider>
    </StreamingProvider>,
  );
  return { onSendMessage };
}

const withMessages = (...contents: string[]): Conversation => ({
  ...conversation,
  messages: contents.map((content, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: '2024-01-01T10:01:00Z',
    content,
  })) as Message[],
});

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

describe('ChatInterface persisted errors', () => {
  it('renders an assistant error together with its tool history', () => {
    renderChat({
      onSaveAttachment: vi.fn(),
      conversation: {
        ...conversation,
        messages: [{
          id: 'assistant-error',
          role: 'assistant',
          timestamp: '2024-01-01T10:01:00Z',
          content: '',
          error: 'Model returned no final text after using tools.',
          toolUse: [{ type: 'search_directory', input: { query: 'cost basis' }, result: 'none' }],
        }],
      },
    });

    expect(screen.getByText('Model returned no final text after using tools.')).toBeTruthy();
    expect(document.querySelector('.response-summary.status-error')).toBeTruthy();
    expect(document.querySelector('.tool-use-indicator')).toBeTruthy();
  });

  it('keeps the reasoning a failed turn streamed, collapsed until opened', () => {
    renderChat({
      onSaveAttachment: vi.fn(),
      conversation: {
        ...conversation,
        messages: [{
          id: 'assistant-error',
          role: 'assistant',
          timestamp: '2024-01-01T10:01:00Z',
          content: 'Partial answer',
          error: 'upstream connection reset',
          partialReasoning: 'Comparing the two fares first.',
        }],
      },
    });

    const toggle = screen.getByRole('button', { name: /Incomplete reasoning/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Comparing the two fares first.')).toBeTruthy();
    expect(screen.getByText('upstream connection reset')).toBeTruthy();
  });
});

describe('ChatInterface incomplete answers', () => {
  const answer = (extra: Partial<Message>) => ({
    ...conversation,
    messages: [{
      id: 'assistant-partial',
      role: 'assistant' as const,
      timestamp: '2024-01-01T10:01:00Z',
      content: 'Here is what I found so far.',
      ...extra,
    }],
  });

  it('says an answer was cut short when the turn ran out of context', () => {
    renderChat({
      onSaveAttachment: vi.fn(),
      conversation: answer({ incompleteReason: 'context_budget' }),
    });

    // The answer itself is still shown as a real answer, not an error.
    expect(screen.getByText('Here is what I found so far.')).toBeTruthy();
    expect(document.querySelector('.response-summary.status-error')).toBeNull();

    const notice = document.querySelector('.response-incomplete-notice');
    expect(notice?.textContent).toContain('Stopped early');
    expect(notice?.textContent).toContain('context limit');
  });

  it('says an answer was cut off when the model hit its reply limit', () => {
    // Observed in a real 621s research turn: 27k characters ending mid-word,
    // presented as a finished answer.
    renderChat({
      onSaveAttachment: vi.fn(),
      conversation: answer({ incompleteReason: 'output_limit' }),
    });

    const notice = document.querySelector('.response-incomplete-notice');
    expect(notice?.textContent).toContain('Cut off');
    expect(notice?.textContent).toContain('maximum reply length');
  });

  it('says an answer stopped when the tool-use safety limit was reached', () => {
    renderChat({
      onSaveAttachment: vi.fn(),
      conversation: answer({ incompleteReason: 'iteration_limit' }),
    });

    const notice = document.querySelector('.response-incomplete-notice');
    expect(notice?.textContent).toContain('Stopped early');
    expect(notice?.textContent).toContain('tool-use safety limit');
  });

  it('leaves an ordinary answer unlabelled', () => {
    renderChat({ onSaveAttachment: vi.fn(), conversation: answer({}) });

    expect(screen.getByText('Here is what I found so far.')).toBeTruthy();
    expect(document.querySelector('.response-incomplete-notice')).toBeNull();
  });
});

describe('ChatInterface image preparation feedback', () => {
  it('shows one indicator while multiple images persist, then hands off to streaming', async () => {
    const deferreds: Deferred[] = [];
    const onSaveAttachment = vi.fn(
      () => new Promise<Attachment>((resolve, reject) => deferreds.push({ resolve, reject })),
    );
    const { onSendMessage } = renderChat({ onSaveAttachment });

    await pasteImage('one.png');
    await pasteImage('two.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Indicator appears immediately, before any save resolves; no model call yet.
    const indicator = await screen.findByRole('status');
    expect(indicator.textContent).toContain('Preparing attachments…');
    expect(onSendMessage).not.toHaveBeenCalled();

    // Still exactly one indicator while the saves proceed one by one.
    deferreds[0].resolve({ type: 'image', path: 'attachments/one.png', mimeType: 'image/png' });
    await waitFor(() => expect(onSaveAttachment).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(onSendMessage).not.toHaveBeenCalled();

    // Final save resolves: the indicator yields to the streaming state.
    deferreds[1].resolve({ type: 'image', path: 'attachments/two.png', mimeType: 'image/png' });
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('queues a message submitted during preparation instead of racing it', async () => {
    const deferreds: Deferred[] = [];
    const onSaveAttachment = vi.fn(
      () => new Promise<Attachment>((resolve, reject) => deferreds.push({ resolve, reject })),
    );
    const { onSendMessage } = renderChat({ onSaveAttachment });

    await pasteImage();
    const textarea = screen.getByPlaceholderText('Send a message...');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByRole('status');

    // A second submission while preparing must be queued, not sent concurrently.
    fireEvent.change(textarea, { target: { value: 'follow-up while preparing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('follow-up while preparing')).toBeTruthy();
    expect(onSaveAttachment).toHaveBeenCalledTimes(1);

    deferreds[0].resolve({ type: 'image', path: 'attachments/one.png', mimeType: 'image/png' });
    await waitFor(() => expect(onSendMessage).toHaveBeenCalled());
  });

  it('clears the indicator when an image save fails', async () => {
    const onSaveAttachment = vi.fn(async () => {
      throw new Error('disk full');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onSendMessage } = renderChat({ onSaveAttachment });

    await pasteImage();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save attachments'),
      expect.any(Error),
    );
  });
});

describe('ChatInterface autoscroll', () => {
  it('stays pinned to the bottom when a tool pill arrives with no new text', () => {
    // Regression: the pin only re-ran on new reply text, so a run of tool calls
    // grew the view below the fold without scrolling to follow it.
    let streaming!: ReturnType<typeof useStreamingContext>;
    function Probe() {
      streaming = useStreamingContext();
      return null;
    }
    const { container } = render(
      <StreamingProvider>
        <Probe />
        <MessageQueueProvider>
          <ChatInterface
            conversation={withMessages('hello', 'hi there')}
            onSendMessage={vi.fn(async () => {})}
            onSaveAttachment={vi.fn()}
            loadImageAsBase64={vi.fn(async () => ({ base64: '', mimeType: 'image/png' }))}
            hasProvider
            onModelChange={vi.fn()}
            availableModels={[]}
          />
        </MessageQueueProvider>
      </StreamingProvider>,
    );
    const messages = container.querySelector('.messages-container') as HTMLElement;
    let contentHeight = 600;
    let scrollTop = 0;
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, get: () => contentHeight });
    Object.defineProperty(messages, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });

    act(() => { streaming.startStreaming(conversation.id); });
    contentHeight = 900;
    act(() => { streaming.addToolUse(conversation.id, { type: 'search_directory' }, 'call-1'); });
    expect(scrollTop).toBe(900);

    contentHeight = 1100;
    act(() => { streaming.addToolUse(conversation.id, { type: 'read_file' }, 'call-2'); });
    expect(scrollTop).toBe(1100);
  });

  /** Render a chat whose container reports a fixed size; count scroll writes. */
  function renderScrollable() {
    const conversation = withMessages('hello', 'hi there');
    const tree = () => (
      <StreamingProvider>
        <MessageQueueProvider>
          <ChatInterface
            conversation={conversation}
            onSendMessage={vi.fn(async () => {})}
            onSaveAttachment={vi.fn()}
            loadImageAsBase64={vi.fn(async () => ({ base64: '', mimeType: 'image/png' }))}
            hasProvider
            onModelChange={vi.fn()}
            availableModels={[]}
          />
        </MessageQueueProvider>
      </StreamingProvider>
    );
    const result = render(tree());
    const el = result.container.querySelector('.messages-container') as HTMLElement;
    const state = { scrollTop: 0, writes: 0 };
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => { state.writes++; state.scrollTop = Math.min(value, 600); },
    });
    // A fresh element each time, so React actually re-renders.
    return { el, state, rerender: () => result.rerender(tree()) };
  }

  it('does not touch the scroll position when an idle re-render changes nothing', () => {
    // Regression: the pin re-ran on every render (a dependency was a fresh []),
    // snapping the view while the user scrolled even with nothing streaming.
    const { state, rerender } = renderScrollable();
    rerender();
    const writes = state.writes;
    rerender();
    rerender();
    expect(state.writes).toBe(writes);
  });

  it('stops following as soon as the user scrolls up, even slightly', () => {
    const { el, state, rerender } = renderScrollable();
    state.scrollTop = 600;
    fireEvent.scroll(el);
    // A small touch or trackpad scroll-up that never fires a wheel event.
    state.scrollTop = 580;
    fireEvent.scroll(el);
    rerender();
    expect(state.scrollTop).toBe(580);

    // Back at the bottom: following resumes.
    state.scrollTop = 600;
    fireEvent.scroll(el);
    expect(state.scrollTop).toBe(600);
  });
});

describe('ChatInterface stopping with queued messages', () => {
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

  /** A send that runs until stopped, then settles when `settle` is called. */
  function stoppableSend() {
    const settles: Array<() => void> = [];
    const finishes: Array<() => void> = [];
    const onSendMessage = vi.fn(
      (_content: string, _attachments: unknown[], _onChunk: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          finishes.push(resolve);
          // Stopping writes the partial reply back before the send settles.
          signal.addEventListener('abort', () => settles.push(() => reject(abortError())));
        }),
    );
    return { onSendMessage, settle: () => act(() => settles.shift()?.()), finish: () => act(() => finishes.shift()?.()) };
  }

  function type(text: string) {
    const textarea = screen.getByPlaceholderText('Send a message...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: text } });
    return textarea;
  }

  async function sendThenQueue(onSendMessage: ReturnType<typeof stoppableSend>['onSendMessage']) {
    renderChat({ onSaveAttachment: vi.fn(), onSendMessage });
    type('give me some lorem ipsum');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
    type('now in French');
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(await screen.findByText('now in French')).toBeTruthy();
  }

  it('puts queued messages back in the composer on Stop instead of sending them', async () => {
    // Regression: Stop sent the queued message at once; the stopped turn's
    // cleanup then hid the new turn, which ran (and saved) invisibly.
    const { onSendMessage, settle } = stoppableSend();
    await sendThenQueue(onSendMessage);

    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    await settle();

    const textarea = screen.getByPlaceholderText('Send a message...') as HTMLTextAreaElement;
    expect(textarea.value).toBe('now in French');
    expect(document.querySelector('.queued-message')).toBeNull();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });

  it('holds a send made while a stopped turn settles, then sends it visibly', async () => {
    const { onSendMessage, settle } = stoppableSend();
    renderChat({ onSaveAttachment: vi.fn(), onSendMessage });
    type('give me some lorem ipsum');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    // Sent before the stopped reply has been written back: it must wait.
    type('something else');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSendMessage).toHaveBeenCalledTimes(1);

    await settle();
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(2));
    expect(onSendMessage.mock.calls[1][0]).toBe('something else');
    // The new turn is shown as running and can itself be stopped.
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeTruthy();
  });

  it('still sends the queue once a reply finishes normally', async () => {
    const { onSendMessage, finish } = stoppableSend();
    await sendThenQueue(onSendMessage);

    await finish();
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(2));
    expect(onSendMessage.mock.calls[1][0]).toBe('now in French');
  });
});
