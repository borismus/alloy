import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Conversation } from '../types';
import { estimateMessageTokens } from '../services/context/estimator';
import { providerRegistry } from '../services/providers';
import './ContextUsageChip.css';

interface ContextUsageChipProps {
  conversation: Conversation;
  onCompactNow?: () => void | Promise<void>;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

export const ContextUsageChip: React.FC<ContextUsageChipProps> = ({
  conversation,
  onCompactNow,
}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { used, window, level } = useMemo(() => {
    const tokens = conversation.messages
      .filter(m => m.role !== 'log')
      .reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const cw = providerRegistry.getContextWindow(conversation.model);
    // Mirrors useSendMessage: messageBudget = contextWindow * 0.5; threshold = budget * 0.7
    const messageBudget = cw ? Math.floor(cw * 0.5) : Infinity;
    const threshold = messageBudget * 0.7;
    let lvl: 'ok' | 'warn' | 'hot' = 'ok';
    if (Number.isFinite(threshold)) {
      if (tokens >= threshold) lvl = 'hot';
      else if (tokens >= threshold * 0.8) lvl = 'warn';
    }
    return { used: tokens, window: cw, level: lvl };
  }, [conversation.messages, conversation.model]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!window) return null; // Unknown context window — don't render rather than mislead

  const handleCompact = async () => {
    if (!onCompactNow || busy) return;
    setBusy(true);
    try {
      await onCompactNow();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className={`ctx-chip ctx-chip-${level}`} ref={popoverRef}>
      <button
        type="button"
        className="ctx-chip-button"
        onClick={() => setOpen(o => !o)}
        title="Context usage"
      >
        {formatTokens(used)} / {formatTokens(window)}
      </button>
      {open && (
        <div className="ctx-chip-popover" role="dialog">
          <div className="ctx-chip-row">
            <span>Estimated context</span>
            <strong>{formatTokens(used)} tok</strong>
          </div>
          <div className="ctx-chip-row">
            <span>Model window</span>
            <strong>{formatTokens(window)} tok</strong>
          </div>
          <div className="ctx-chip-row">
            <span>Last compacted</span>
            <strong>
              {conversation.lastCompactedAt ? formatRelative(conversation.lastCompactedAt) : '—'}
            </strong>
          </div>
          {onCompactNow && (
            <button
              type="button"
              className="ctx-chip-action"
              onClick={handleCompact}
              disabled={busy}
            >
              {busy ? 'Compacting…' : 'Compact now'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
