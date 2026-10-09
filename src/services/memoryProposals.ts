import type { ToolUse } from '../types';
import { getApiBase, getAuthHeadersForApi } from './server-streaming';

/**
 * A model's write to memory.md is only a proposal: the server writes nothing
 * until the user accepts it (see alloy-server/src/routes/memory.rs).
 */
export function isMemoryProposal(tool: ToolUse): boolean {
  // Only a call whose result says it was proposed. Writes from before
  // proposals existed were applied directly ("Successfully wrote…"), and a
  // no-op call changes nothing; neither should offer Accept. Mirrors
  // MEMORY_PROPOSAL_RESULT in alloy-server/src/tools/files.rs.
  if (!tool.result?.startsWith('Proposed a change to memory.md.')) return false;
  const isWrite = tool.type === 'write_file' || tool.type.endsWith('__write_file');
  const path = typeof tool.input?.path === 'string'
    ? tool.input.path.trim().replace(/^\.\//, '').replace(/\\/g, '/')
    : '';
  return isWrite && path === 'memory.md' && !tool.isError && typeof tool.input?.content === 'string';
}

/** Accept (write it, backing up the old version) or reject a proposal. */
export async function decideMemoryProposal(args: {
  conversationId: string;
  messageId: string;
  toolIndex: number;
  accept: boolean;
}): Promise<'accepted' | 'rejected'> {
  const response = await fetch(`${getApiBase()}/api/memory/proposal`, {
    method: 'POST',
    headers: { ...getAuthHeadersForApi(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.decision;
}
