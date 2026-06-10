// Pure DOM logic for find-in-conversation: locating matches and navigating
// between them. Deliberately free of the CSS Custom Highlight API so it can be
// unit-tested in any DOM environment (the painting half lives in the component).

/**
 * Find all case-insensitive occurrences of `search` within the text nodes of
 * `container`, returned as DOM Ranges (one per match, in document order).
 * Returns [] for a null container or an empty/whitespace-only query.
 */
export function findMatchRanges(container: HTMLElement | null, search: string): Range[] {
  if (!container || !search.trim()) {
    return [];
  }

  const ranges: Range[] = [];
  const lowerSearch = search.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node.textContent?.toLowerCase() || '';
    let startIndex = 0;
    let index: number;
    while ((index = text.indexOf(lowerSearch, startIndex)) >= 0) {
      const range = new Range();
      range.setStart(node, index);
      range.setEnd(node, index + search.length);
      ranges.push(range);
      startIndex = index + search.length;
    }
    node = walker.nextNode() as Text | null;
  }

  return ranges;
}

/** Index of the next match, wrapping past the end. Returns 0 when there are none. */
export function nextMatchIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  return (current + 1) % count;
}

/** Index of the previous match, wrapping past the start. Returns 0 when there are none. */
export function prevMatchIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  return (current - 1 + count) % count;
}
