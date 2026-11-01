import { useEffect, useState } from 'react';
import { vaultService } from '../services/vault';
import { decideProposal } from '../services/proposals';
import { DiffView } from './DiffView';
import { Button } from './ui';
import './ProposalCard.css';

interface ProposalCardProps {
  conversationId: string;
  messageId: string;
  toolIndex: number;
  /** Vault-relative target: memory.md or a file under skills/. */
  path: string;
  proposed: string;
  decision?: 'accepted' | 'rejected';
  /** The conversation holds private material; memory and skills go to every model. */
  isPrivateConversation?: boolean;
}

/**
 * A model's proposed change to memory.md or a skill, shown as a diff against
 * the current file. Nothing is written until the user accepts.
 */
export function ProposalCard({
  conversationId,
  messageId,
  toolIndex,
  path,
  proposed,
  decision: persisted,
  isPrivateConversation = false,
}: ProposalCardProps) {
  const [current, setCurrent] = useState<string | null>(null);
  const [decision, setDecision] = useState(persisted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMemory = path === 'memory.md';
  const subject = isMemory ? 'Memory' : 'Skill';

  useEffect(() => setDecision(persisted), [persisted]);
  useEffect(() => {
    if (decision) return;
    let cancelled = false;
    vaultService.readVaultFile(path)
      .then(text => { if (!cancelled) setCurrent(text ?? ''); })
      .catch(() => { if (!cancelled) setCurrent(''); });
    return () => { cancelled = true; };
  }, [decision, path]);

  const decide = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // An accepted skill reaches the skill lists through the vault watcher.
      setDecision(await decideProposal({ conversationId, messageId, toolIndex, accept }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!decision && current !== null && current === proposed) {
    return (
      <div className="proposal decided" role="status">
        {subject} already matches this change.
      </div>
    );
  }

  if (decision) {
    return (
      <div className="proposal decided" role="status">
        {subject} change {decision}.
      </div>
    );
  }

  return (
    <div className="proposal" role="group" aria-label={`Proposed ${subject.toLowerCase()} change`}>
      <div className="proposal-title">
        {isMemory ? 'Proposed memory change' : <>Proposed change to <code>{path}</code></>}
      </div>
      <p className="proposal-note">
        {isMemory
          ? 'Memory is included in every conversation, with every model.'
          : 'Skills can run in any conversation, with any model.'}
        {isPrivateConversation && (
          <strong> This conversation holds private material, so check that nothing private ends up in it.</strong>
        )}
      </p>
      {current === null ? (
        <p className="proposal-note">Loading current {isMemory ? 'memory' : 'file'}…</p>
      ) : (
        <DiffView oldText={current} newText={proposed} />
      )}
      {error && <p className="proposal-error">{error}</p>}
      <div className="proposal-actions">
        <Button variant="secondary" onPress={() => decide(false)} isDisabled={busy}>Reject</Button>
        <Button variant="primary" onPress={() => decide(true)} isDisabled={busy || current === null}>Accept</Button>
      </div>
    </div>
  );
}
