import React, { useMemo } from 'react';
import { Conversation } from '../types';
import './ThreadCostChip.css';

interface ThreadCostChipProps {
  conversation: Conversation;
}

/**
 * Sum the estimated USD cost across every billed response in a thread —
 * each assistant message's usage plus any sub-agent responses it spawned.
 * Messages from free/unknown models simply omit `usage.cost`.
 */
function totalThreadCost(conversation: Conversation): number {
  return conversation.messages.reduce((sum, m) => {
    let cost = m.usage?.cost ?? 0;
    if (m.subagentResponses?.length) {
      cost += m.subagentResponses.reduce((s, r) => s + (r.usage?.cost ?? 0), 0);
    }
    return sum + cost;
  }, 0);
}

function formatCost(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`; // sub-cent threads still show something meaningful
}

export const ThreadCostChip: React.FC<ThreadCostChipProps> = ({ conversation }) => {
  const total = useMemo(() => totalThreadCost(conversation), [conversation.messages]);

  // No cost data (free models, or nothing billed yet) — don't show a misleading $0.00.
  if (total <= 0) return null;

  return (
    <span className="cost-chip" title="Total estimated cost for this thread">
      {formatCost(total)}
    </span>
  );
};
