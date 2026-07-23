import { describe, it, expect } from 'vitest';
import { lineDiff, collapseDiff, hasDiff } from './lineDiff';

describe('lineDiff', () => {
  it('marks unchanged lines as context', () => {
    const rows = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(rows.every(r => r.type === 'context')).toBe(true);
    expect(rows.map(r => r.text)).toEqual(['a', 'b', 'c']);
  });

  it('detects an inserted line', () => {
    const rows = lineDiff('a\nc', 'a\nb\nc');
    expect(rows).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    const rows = lineDiff('a\nb\nc', 'a\nc');
    expect(rows).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('represents a changed line as delete + add', () => {
    const rows = lineDiff('hello world', 'hello there');
    expect(rows).toEqual([
      { type: 'del', text: 'hello world' },
      { type: 'add', text: 'hello there' },
    ]);
  });

  it('falls back to a bounded whole-block diff for large documents', () => {
    // 1,500 × 1,500 exceeds MAX_LCS_CELLS; allocating the quadratic table here
    // would otherwise consume tens of MB and scales into GBs for larger notes.
    const oldText = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join('\n');
    const rows = lineDiff(oldText, newText);

    expect(rows).toEqual([
      { type: 'del', text: oldText },
      { type: 'add', text: newText },
    ]);
  });
});

describe('collapseDiff', () => {
  it('collapses long unchanged runs into gaps but keeps context', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const newText = oldText.replace('line10', 'line10-edited');
    const items = collapseDiff(lineDiff(oldText, newText), 2);

    // Leading and trailing unchanged blocks become gaps.
    expect(items[0]).toEqual({ type: 'gap', count: expect.any(Number) });
    expect(items.some(i => i.type === 'add')).toBe(true);
    expect(items.some(i => i.type === 'del')).toBe(true);
    // Context lines immediately around the change are preserved.
    expect(items.some(i => i.type === 'context' && 'text' in i && i.text === 'line9')).toBe(true);
    expect(items.some(i => i.type === 'context' && 'text' in i && i.text === 'line11')).toBe(true);
  });
});

describe('hasDiff', () => {
  it('ignores a trailing newline difference', () => {
    expect(hasDiff('a\nb', 'a\nb\n')).toBe(false);
  });

  it('reports a real change', () => {
    expect(hasDiff('a\nb', 'a\nc')).toBe(true);
  });
});
