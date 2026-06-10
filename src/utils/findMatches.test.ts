import { describe, it, expect } from 'vitest';
import { findMatchRanges, nextMatchIndex, prevMatchIndex } from './findMatches';

function container(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

// The text actually covered by a range, read back from the DOM.
function matchedText(range: Range): string {
  const node = range.startContainer;
  return (node.textContent || '').slice(range.startOffset, range.endOffset);
}

describe('findMatchRanges', () => {
  it('returns nothing for an empty or whitespace query', () => {
    const el = container('hello world');
    expect(findMatchRanges(el, '')).toEqual([]);
    expect(findMatchRanges(el, '   ')).toEqual([]);
  });

  it('returns nothing for a null container', () => {
    expect(findMatchRanges(null, 'x')).toEqual([]);
  });

  it('finds a single match', () => {
    const ranges = findMatchRanges(container('the quick brown fox'), 'quick');
    expect(ranges).toHaveLength(1);
    expect(matchedText(ranges[0])).toBe('quick');
    expect(ranges[0].startOffset).toBe(4);
    expect(ranges[0].endOffset).toBe(9);
  });

  it('finds multiple non-overlapping matches within one text node', () => {
    const ranges = findMatchRanges(container('foo bar foo baz foo'), 'foo');
    expect(ranges).toHaveLength(3);
    expect(ranges.map((r) => r.startOffset)).toEqual([0, 8, 16]);
    expect(ranges.every((r) => matchedText(r) === 'foo')).toBe(true);
  });

  it('is case-insensitive but preserves the original length', () => {
    const ranges = findMatchRanges(container('Foo FOO foO'), 'foo');
    expect(ranges).toHaveLength(3);
    // offsets point into the original-cased text
    expect(matchedText(ranges[0])).toBe('Foo');
    expect(matchedText(ranges[1])).toBe('FOO');
    expect(matchedText(ranges[2])).toBe('foO');
  });

  it('finds matches spread across separate text nodes / elements', () => {
    const ranges = findMatchRanges(container('<p>alpha cat</p><span>cat beta</span><div>scatter</div>'), 'cat');
    // "cat" in <p>, "cat" in <span>, and "cat" inside "scatter" in <div>
    expect(ranges).toHaveLength(3);
    // each range lives in a different text node
    const nodes = new Set(ranges.map((r) => r.startContainer));
    expect(nodes.size).toBe(3);
  });

  it('returns an empty array when there is no match', () => {
    expect(findMatchRanges(container('nothing to see here'), 'xyz')).toEqual([]);
  });

  it('does not find a query that spans across two text nodes', () => {
    // matching is per-text-node, so "ab" split across nodes is not a match
    expect(findMatchRanges(container('<b>a</b><b>b</b>'), 'ab')).toEqual([]);
  });
});

describe('nextMatchIndex / prevMatchIndex', () => {
  it('advances and wraps forward', () => {
    expect(nextMatchIndex(0, 3)).toBe(1);
    expect(nextMatchIndex(1, 3)).toBe(2);
    expect(nextMatchIndex(2, 3)).toBe(0); // wrap to start
  });

  it('steps back and wraps backward', () => {
    expect(prevMatchIndex(2, 3)).toBe(1);
    expect(prevMatchIndex(1, 3)).toBe(0);
    expect(prevMatchIndex(0, 3)).toBe(2); // wrap to end
  });

  it('is a no-op (0) when there are no matches', () => {
    expect(nextMatchIndex(0, 0)).toBe(0);
    expect(prevMatchIndex(0, 0)).toBe(0);
  });

  it('handles a single match by staying put', () => {
    expect(nextMatchIndex(0, 1)).toBe(0);
    expect(prevMatchIndex(0, 1)).toBe(0);
  });
});
