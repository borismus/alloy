import { describe, expect, it } from 'vitest';
import { mergeConversationSummaries } from '../App';
import type { Conversation } from '../types';

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    model: 'anthropic/claude',
    title: 'Test',
    messages: [],
    ...over,
  };
}

/** Shaped like `loadConversationSummaries()` output: metadata only. */
function summary(over: Partial<Conversation> = {}): Conversation {
  return conv({ messages: [], messagesLoaded: false, ...over });
}

const msg = { id: 'm1', role: 'user' as const, content: 'hi', timestamp: '2024-01-01T00:00:00.000Z' };

describe('mergeConversationSummaries', () => {
  it('keeps loaded messages for an unchanged conversation', () => {
    // The trap: summaries carry messages: [], so assigning them wholesale would
    // blank whichever conversation is open.
    const current = [conv({ messages: [msg], messagesLoaded: true })];
    const summaries = [summary()];

    const merged = mergeConversationSummaries(current, summaries);

    expect(merged[0].messages).toEqual([msg]);
    expect(merged[0].messagesLoaded).toBe(true);
  });

  it('drops stale messages when the file changed on disk', () => {
    const current = [conv({ messages: [msg], messagesLoaded: true })];
    const summaries = [summary({ updated: '2024-06-01T00:00:00.000Z' })];

    const merged = mergeConversationSummaries(current, summaries);

    expect(merged[0].messagesLoaded).toBe(false);
    expect(merged[0].messages).toEqual([]);
    expect(merged[0].updated).toBe('2024-06-01T00:00:00.000Z');
  });

  it('adds conversations created while disconnected', () => {
    // The core bug: changes during a watcher gap were never picked up.
    const current = [conv({ id: 'existing' })];
    const summaries = [summary({ id: 'existing' }), summary({ id: 'created-while-offline' })];

    const merged = mergeConversationSummaries(current, summaries);

    expect(merged.map(c => c.id)).toEqual(['existing', 'created-while-offline']);
  });

  it('drops conversations deleted while disconnected', () => {
    const current = [conv({ id: 'a' }), conv({ id: 'gone' })];
    const summaries = [summary({ id: 'a' })];

    expect(mergeConversationSummaries(current, summaries).map(c => c.id)).toEqual(['a']);
  });

  it('takes fresh metadata even when messages are preserved', () => {
    const current = [conv({ title: 'Old title', messages: [msg], messagesLoaded: true })];
    const summaries = [summary({ title: 'Renamed' })];

    const merged = mergeConversationSummaries(current, summaries);

    expect(merged[0].title).toBe('Renamed');
    expect(merged[0].messages).toEqual([msg]);
  });

  it('leaves never-hydrated conversations as summaries', () => {
    const current = [conv({ messagesLoaded: false })];
    const summaries = [summary()];

    expect(mergeConversationSummaries(current, summaries)[0].messagesLoaded).toBe(false);
  });
});

describe('resync idempotence', () => {
  it('returns the SAME array when nothing changed', () => {
    // The resync runs on every window focus and almost always finds nothing new.
    // Returning a fresh array rebuilt the timeline and re-rendered the whole
    // sidebar, which looked like the app spontaneously refreshing.
    const current = [conv({ id: 'a' }), conv({ id: 'b', messages: [msg], messagesLoaded: true })];
    const summaries = [summary({ id: 'a' }), summary({ id: 'b' })];

    expect(mergeConversationSummaries(current, summaries)).toBe(current);
  });

  it('returns a new array when something actually changed', () => {
    const current = [conv({ id: 'a', title: 'Old' })];
    const summaries = [summary({ id: 'a', title: 'New' })];

    const merged = mergeConversationSummaries(current, summaries);
    expect(merged).not.toBe(current);
    expect(merged[0].title).toBe('New');
  });

  it('returns a new array when a conversation appears or disappears', () => {
    const current = [conv({ id: 'a' })];
    expect(mergeConversationSummaries(current, [summary({ id: 'a' }), summary({ id: 'b' })]))
      .not.toBe(current);
    expect(mergeConversationSummaries(current, [])).not.toBe(current);
  });

  it('keeps per-item identity for untouched conversations', () => {
    // Row-level memoization depends on this, not just the array identity.
    const stable = conv({ id: 'a', messages: [msg], messagesLoaded: true });
    const merged = mergeConversationSummaries(
      [stable, conv({ id: 'b' })],
      [summary({ id: 'a' }), summary({ id: 'b', title: 'Renamed' })],
    );
    expect(merged[0]).toBe(stable);
    expect(merged[1].title).toBe('Renamed');
  });
});
