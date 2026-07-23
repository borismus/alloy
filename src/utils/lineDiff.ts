// Minimal line-based diff (LCS) used by the in-app AI edit review. Kept
// dependency-free — notes and tasks are small, so the O(m·n) table is fine.

export type DiffRowType = 'add' | 'del' | 'context';

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

export type DiffItem = DiffRow | { type: 'gap'; count: number };

// number[][] stores at least 8 bytes/cell plus row/array overhead. Keep the LCS
// table comfortably bounded; larger documents use a two-row whole-block diff.
const MAX_LCS_CELLS = 2_000_000;

/** Line-level diff of two strings, longest-common-subsequence based. */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length;
  const n = b.length;

  if (oldText === newText) {
    return a.map(text => ({ type: 'context' as const, text }));
  }

  // Avoid both an unbounded quadratic allocation and thousands of rendered
  // rows. The text remains reviewable via pre-wrapped delete/add blocks.
  if (m * n > MAX_LCS_CELLS) {
    return [
      { type: 'del', text: oldText },
      { type: 'add', text: newText },
    ];
  }

  // dp[i][j] = length of the LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) rows.push({ type: 'del', text: a[i++] });
  while (j < n) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

/**
 * Collapse long runs of unchanged lines into `gap` markers, keeping `context`
 * lines of context around each change so the reviewer sees where edits land.
 */
export function collapseDiff(rows: DiffRow[], context = 3): DiffItem[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.type !== 'context') {
      const start = Math.max(0, idx - context);
      const end = Math.min(rows.length - 1, idx + context);
      for (let k = start; k <= end; k++) keep[k] = true;
    }
  });

  const items: DiffItem[] = [];
  let gap = 0;
  for (let idx = 0; idx < rows.length; idx++) {
    if (keep[idx]) {
      if (gap > 0) {
        items.push({ type: 'gap', count: gap });
        gap = 0;
      }
      items.push(rows[idx]);
    } else {
      gap++;
    }
  }
  if (gap > 0) items.push({ type: 'gap', count: gap });
  return items;
}

/** True when the two texts differ (ignoring a single trailing newline). */
export function hasDiff(oldText: string, newText: string): boolean {
  return oldText.replace(/\n+$/, '') !== newText.replace(/\n+$/, '');
}
