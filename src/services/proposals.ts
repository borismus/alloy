import type { ToolUse } from '../types';
import { getApiBase, getAuthHeadersForApi } from './server-streaming';

/**
 * A model's write to memory.md or under skills/ is only a proposal: the server
 * writes nothing until the user accepts it (see alloy-server/src/routes/proposal.rs).
 */
export function proposedPath(tool: ToolUse): string | null {
  const isWrite = tool.type === 'write_file' || tool.type.endsWith('__write_file');
  if (!isWrite || tool.isError || typeof tool.input?.content !== 'string') return null;
  const path = typeof tool.input?.path === 'string'
    ? tool.input.path.trim().replace(/^\.\//, '').replace(/\\/g, '/')
    : '';
  if (path !== 'memory.md' && !path.startsWith('skills/')) return null;
  // Only a call whose result says it was proposed. Writes from before
  // proposals existed were applied directly ("Successfully wrote…"), and a
  // no-op call changes nothing; neither should offer Accept. Mirrors
  // proposal_result in alloy-server/src/tools/files.rs.
  return tool.result?.startsWith(`Proposed a change to ${path}.`) ? path : null;
}

/** Accept (write it) or reject a proposal. */
export async function decideProposal(args: {
  conversationId: string;
  messageId: string;
  toolIndex: number;
  accept: boolean;
}): Promise<'accepted' | 'rejected'> {
  const response = await fetch(`${getApiBase()}/api/proposal`, {
    method: 'POST',
    headers: { ...getAuthHeadersForApi(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.decision;
}
