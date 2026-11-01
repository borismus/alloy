import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { watch, type WatchEvent } from '@tauri-apps/plugin-fs';
import { useVaultWatcher, type VaultWatcherCallbacks } from './useVaultWatcher';

// '@tauri-apps/plugin-fs' resolves to this shim (vite.config.ts alias), so one
// mock covers both imports the hook makes.
vi.mock('../services/api/tauri-fs-http', () => ({
  watch: vi.fn(),
  exists: vi.fn(),
  onWatchReconnect: () => () => {},
}));

afterEach(() => vi.restoreAllMocks());

function callbacks(): VaultWatcherCallbacks {
  return {
    onConversationAdded: vi.fn(),
    onConversationRemoved: vi.fn(),
    onConversationModified: vi.fn(),
    onConfigChanged: vi.fn(),
    onNoteAdded: vi.fn(),
    onNoteModified: vi.fn(),
    onNoteRemoved: vi.fn(),
    onTaskModified: vi.fn(),
    onSkillsChanged: vi.fn(),
  };
}

async function startWatcher(cb: VaultWatcherCallbacks) {
  let handler: ((event: WatchEvent) => void) | undefined;
  vi.mocked(watch).mockImplementation(async (_path, h) => {
    handler = h;
    return () => {};
  });
  renderHook(() => useVaultWatcher({ vaultPath: '/vault', enabled: true }, cb));
  await waitFor(() => expect(handler).toBeDefined());
  return (path: string, type: WatchEvent['type'] = { modify: { kind: 'data', mode: 'content' } }) =>
    handler!({ type, paths: [path] } as WatchEvent);
}

it('reports any change under skills/, including removals', async () => {
  const cb = callbacks();
  const fire = await startWatcher(cb);

  fire('/vault/skills/flux-highlights/SKILL.md');
  fire('/vault/skills/new-skill/SKILL.md', { create: { kind: 'file' } });
  fire('/vault/skills/old-skill/SKILL.md', { remove: { kind: 'file' } });
  await waitFor(() => expect(cb.onSkillsChanged).toHaveBeenCalledTimes(3));
});

it('keeps notes about skills and other files out of it', async () => {
  const cb = callbacks();
  const fire = await startWatcher(cb);

  fire('/vault/notes/skills/idea.md');
  fire('/vault/tasks/2026-01-01-0900-ab12.yaml');
  await waitFor(() => expect(cb.onNoteModified).toHaveBeenCalledWith('idea.md'));
  expect(cb.onTaskModified).toHaveBeenCalled();
  expect(cb.onSkillsChanged).not.toHaveBeenCalled();
});
