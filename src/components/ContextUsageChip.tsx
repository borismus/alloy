import { useMemo } from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { Conversation, Message, ModelInfo } from '../types';
import './ContextUsageChip.css';

interface ContextUsageChipProps {
  conversation: Conversation;
  availableModels: ModelInfo[];
  /** Resolved server compaction settings (see Config.compaction). */
  compaction?: { enabled: boolean; triggerTokens: number };
}

// Rough JS-side token estimate: ~4 chars/token + per-message overhead +
// ~1k tokens per image attachment. Used only for displaying the context
// usage chip — the embedded server doesn't currently expose live token
// counts mid-conversation.
function estimateMessageTokens(message: Message): number {
  let tokens = Math.ceil(message.content.length / 4) + 10;
  if (message.attachments?.length) {
    tokens += message.attachments.length * 1000;
  }
  return tokens;
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
  availableModels,
  compaction,
}) => {

  const { used, limit, limitLabel, level } = useMemo(() => {
    const tokens = conversation.messages
      .filter(m => m.role !== 'log')
      .reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const cw = availableModels.find(m => m.key === conversation.model)?.contextWindow;

    // The limit a conversation actually meets is the compaction trigger, not the
    // context window: the server folds older turns into a summary above it, and
    // with the default 16k trigger that happens at ~6% of a 262k window. Showing
    // the window left the chip calm while compaction was already running.
    // Mirrors `effective_budget` in alloy-server/src/compaction.rs, including its
    // 0.6x clamp for models whose window is smaller than the trigger.
    const compacts = compaction?.enabled !== false && compaction != null;
    const effective = compacts
      ? (cw ? Math.min(compaction.triggerTokens, Math.floor(cw * 0.6)) : compaction.triggerTokens)
      : cw;

    let lvl: 'ok' | 'warn' | 'compacting' = 'ok';
    if (effective) {
      if (tokens >= effective) lvl = compacts ? 'compacting' : 'warn';
      else if (tokens >= effective * 0.8) lvl = 'warn';
    }
    return {
      used: tokens,
      limit: effective,
      limitLabel: compacts ? 'Compacts above' : 'Model window',
      level: lvl,
    };
  }, [conversation.messages, conversation.model, availableModels, compaction]);

  // Nothing reliable to divide by — don't render rather than mislead.
  if (!limit) return null;

  return (
    <div className={`ctx-chip ctx-chip-${level}`}>
      <DialogTrigger>
        <Button className="ctx-chip-button" aria-label="Context usage">
          {formatTokens(used)} / {formatTokens(limit)}
        </Button>
        <Popover className="ctx-chip-popover" placement="bottom end">
          <Dialog className="ctx-chip-dialog" aria-label="Context usage">
            {() => (
              <>
                <div className="ctx-chip-row">
                  <span>Estimated context</span>
                  <strong>{formatTokens(used)} tok</strong>
                </div>
                <div className="ctx-chip-row">
                  <span>{limitLabel}</span>
                  <strong>{formatTokens(limit)} tok</strong>
                </div>
                {level === 'compacting' && (
                  <p className="ctx-chip-note">
                    Older turns are being summarised so the conversation keeps fitting.
                    Everything stays in the transcript.
                  </p>
                )}
                <div className="ctx-chip-row">
                  <span>Last compacted</span>
                  <strong>
                    {conversation.lastCompactedAt ? formatRelative(conversation.lastCompactedAt) : '—'}
                  </strong>
                </div>
              </>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
};
