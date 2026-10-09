import { useEffect, useState } from 'react';
import { vaultService } from '../services/vault';
import { decideMemoryProposal } from '../services/memoryProposals';
import { DiffView } from './DiffView';
import { Button } from './ui';
import './MemoryProposalCard.css';

interface MemoryProposalCardProps {
  conversationId: string;
  messageId: string;
  toolIndex: number;
  proposed: string;
  decision?: 'accepted' | 'rejected';
  /** The conversation holds private material; memory goes to every model. */
  isPrivateConversation?: boolean;
}

/**
 * A model's proposed change to memory.md, shown as a diff against the current
 * file. Nothing is written until the user accepts.
 */
export function MemoryProposalCard({
  conversationId,
  messageId,
  toolIndex,
  proposed,
  decision: persisted,
  isPrivateConversation = false,
}: MemoryProposalCardProps) {
  const [current, setCurrent] = useState<string | null>(null);
  const [decision, setDecision] = useState(persisted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDecision(persisted), [persisted]);
  useEffect(() => {
    if (decision) return;
    let cancelled = false;
    vaultService.loadMemory()
      .then(memory => { if (!cancelled) setCurrent(memory?.content ?? ''); })
      .catch(() => { if (!cancelled) setCurrent(''); });
    return () => { cancelled = true; };
  }, [decision]);

  const decide = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setDecision(await decideMemoryProposal({ conversationId, messageId, toolIndex, accept }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!decision && current !== null && current === proposed) {
    return (
      <div className="memory-proposal decided" role="status">
        Memory already matches this change.
      </div>
    );
  }

  if (decision) {
    return (
      <div className="memory-proposal decided" role="status">
        {decision === 'accepted' ? 'Memory change accepted.' : 'Memory change rejected.'}
      </div>
    );
  }

  return (
    <div className="memory-proposal" role="group" aria-label="Proposed memory change">
      <div className="memory-proposal-title">Proposed memory change</div>
      <p className="memory-proposal-note">
        Memory is included in every conversation, with every model.
        {isPrivateConversation && (
          <strong> This conversation holds private material, so check that nothing private ends up in it.</strong>
        )}
      </p>
      {current === null ? (
        <p className="memory-proposal-note">Loading current memory…</p>
      ) : (
        <DiffView oldText={current} newText={proposed} />
      )}
      {error && <p className="memory-proposal-error">{error}</p>}
      <div className="memory-proposal-actions">
        <Button variant="secondary" onPress={() => decide(false)} isDisabled={busy}>Reject</Button>
        <Button variant="primary" onPress={() => decide(true)} isDisabled={busy || current === null}>Accept</Button>
      </div>
    </div>
  );
}
