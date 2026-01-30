import { useMemo } from 'react';
import { ApprovalRequest } from '../services/tools/executor';
import './WriteApprovalModal.css';

interface WriteApprovalModalProps {
  request: ApprovalRequest;
  onApprove: () => void;
  onReject: () => void;
}

type DiffLine =
  | { type: 'unchanged'; content: string }
  | { type: 'added'; content: string }
  | { type: 'removed'; content: string };

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const CONTEXT_LINES = 3;

/**
 * Simple line-by-line diff using longest common subsequence.
 */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'unchanged', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      diff.unshift({ type: 'removed', content: oldLines[i - 1] });
      i--;
    }
  }

  return diff;
}

/**
 * Group diff lines into hunks with context.
 */
function groupIntoHunks(diff: DiffLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: DiffLine[] = [];
  let hunkStart = -1;
  let unchangedCount = 0;
  let oldLineNum = 0;
  let newLineNum = 0;
  let hunkOldStart = 0;
  let hunkNewStart = 0;

  for (let i = 0; i < diff.length; i++) {
    const line = diff[i];
    const isChange = line.type !== 'unchanged';

    if (isChange) {
      // Starting a new hunk or continuing one
      if (hunkStart === -1) {
        // New hunk - include context before
        hunkStart = i;
        const contextStart = Math.max(0, i - CONTEXT_LINES);
        hunkOldStart = oldLineNum - (i - contextStart);
        hunkNewStart = newLineNum - (i - contextStart);

        // Recalculate line numbers for context
        let tempOld = 0, tempNew = 0;
        for (let j = 0; j < contextStart; j++) {
          if (diff[j].type !== 'added') tempOld++;
          if (diff[j].type !== 'removed') tempNew++;
        }
        hunkOldStart = tempOld;
        hunkNewStart = tempNew;

        for (let j = contextStart; j < i; j++) {
          currentHunk.push(diff[j]);
        }
      } else if (unchangedCount > 0) {
        // Add the unchanged lines we were tracking
        for (let j = i - unchangedCount; j < i; j++) {
          currentHunk.push(diff[j]);
        }
      }
      currentHunk.push(line);
      unchangedCount = 0;
    } else {
      // Unchanged line
      if (hunkStart !== -1) {
        unchangedCount++;
        if (unchangedCount > CONTEXT_LINES * 2) {
          // End current hunk - add context after
          for (let j = i - unchangedCount + 1; j <= i - unchangedCount + CONTEXT_LINES; j++) {
            if (j < diff.length) currentHunk.push(diff[j]);
          }
          hunks.push({ oldStart: hunkOldStart, newStart: hunkNewStart, lines: currentHunk });
          currentHunk = [];
          hunkStart = -1;
          unchangedCount = 0;
        }
      }
    }

    if (line.type !== 'added') oldLineNum++;
    if (line.type !== 'removed') newLineNum++;
  }

  // Finish last hunk
  if (currentHunk.length > 0) {
    // Add remaining context
    const lastChangeIdx = diff.length - 1;
    for (let j = lastChangeIdx - unchangedCount + 1; j <= Math.min(lastChangeIdx, lastChangeIdx - unchangedCount + CONTEXT_LINES); j++) {
      if (j >= 0 && j < diff.length && !currentHunk.includes(diff[j])) {
        currentHunk.push(diff[j]);
      }
    }
    hunks.push({ oldStart: hunkOldStart, newStart: hunkNewStart, lines: currentHunk });
  }

  return hunks;
}

/**
 * Split hunk lines into left (old) and right (new) for side-by-side display.
 */
function splitHunkForSideBySide(lines: DiffLine[]): { left: (DiffLine | null)[]; right: (DiffLine | null)[] } {
  const left: (DiffLine | null)[] = [];
  const right: (DiffLine | null)[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.type === 'unchanged') {
      left.push(line);
      right.push(line);
      i++;
    } else if (line.type === 'removed') {
      // Collect consecutive removed lines
      const removedLines: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'removed') {
        removedLines.push(lines[i]);
        i++;
      }
      // Collect consecutive added lines
      const addedLines: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'added') {
        addedLines.push(lines[i]);
        i++;
      }
      // Pair them up
      const maxLen = Math.max(removedLines.length, addedLines.length);
      for (let j = 0; j < maxLen; j++) {
        left.push(j < removedLines.length ? removedLines[j] : null);
        right.push(j < addedLines.length ? addedLines[j] : null);
      }
    } else if (line.type === 'added') {
      // Added without preceding removed
      left.push(null);
      right.push(line);
      i++;
    }
  }

  return { left, right };
}

export function WriteApprovalModal({ request, onApprove, onReject }: WriteApprovalModalProps) {
  const { path, originalContent, newContent } = request;
  const isNewFile = !originalContent;

  const hunks = useMemo(() => {
    if (isNewFile) return null;
    const diff = computeDiff(originalContent, newContent);
    return groupIntoHunks(diff);
  }, [originalContent, newContent, isNewFile]);

  return (
    <div className="write-approval-overlay" onClick={onReject}>
      <div className="write-approval-modal" onClick={e => e.stopPropagation()}>
        <div className="write-approval-header">
          <h2>{isNewFile ? 'Create File' : 'Approve Changes'}</h2>
          <span className="write-approval-path">{path}</span>
          <button className="close-btn" onClick={onReject}>&times;</button>
        </div>

        <div className="write-approval-content">
          {isNewFile ? (
            <div className="write-approval-single">
              <h3>New Content</h3>
              <pre className="diff-content new-content">{newContent}</pre>
            </div>
          ) : hunks && hunks.length > 0 ? (
            <div className="diff-hunks">
              {hunks.map((hunk, hunkIdx) => {
                const { left, right } = splitHunkForSideBySide(hunk.lines);
                return (
                  <div key={hunkIdx} className="diff-hunk">
                    <div className="diff-hunk-header">
                      @@ -{hunk.oldStart + 1} +{hunk.newStart + 1} @@
                    </div>
                    <div className="diff-side-by-side">
                      <div className="diff-side diff-left">
                        {left.map((line, idx) => (
                          <div
                            key={idx}
                            className={`diff-line ${line ? `diff-${line.type}` : 'diff-empty'}`}
                          >
                            <span className="diff-prefix">
                              {line?.type === 'removed' ? '-' : line?.type === 'unchanged' ? ' ' : ''}
                            </span>
                            <span className="diff-text">{line?.content ?? ''}</span>
                          </div>
                        ))}
                      </div>
                      <div className="diff-side diff-right">
                        {right.map((line, idx) => (
                          <div
                            key={idx}
                            className={`diff-line ${line ? `diff-${line.type}` : 'diff-empty'}`}
                          >
                            <span className="diff-prefix">
                              {line?.type === 'added' ? '+' : line?.type === 'unchanged' ? ' ' : ''}
                            </span>
                            <span className="diff-text">{line?.content ?? ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="diff-no-changes">No changes detected</div>
          )}
        </div>

        <div className="write-approval-actions">
          <button className="btn-secondary" onClick={onReject}>
            Reject
          </button>
          <button className="btn-primary" onClick={onApprove}>
            {isNewFile ? 'Create' : 'Apply Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}