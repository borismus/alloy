import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from '@tauri-apps/plugin-fs';
import { VaultService } from './vault';
import { SkillRegistry } from './skills/registry';

// Startup moved from a round trip per file to one GET /api/startup. These
// tests load the same vault both ways and require identical results, so the
// shortcut can't change what the app shows.

interface FakeFile { content: string; mtime: number }

const longMessages = Array.from({ length: 60 }, (_, i) => `  - role: user\n    content: message ${i}\n`).join('');

/** path (relative to the vault root) -> file. Folders are implied. */
const VAULT: Record<string, FakeFile> = {
  'config.yaml': { content: 'version: 2\n', mtime: 1 },
  'memory.md': { content: '# Memory\n\n- likes trains ✓\n', mtime: 1_700_000_000_000 },
  'conversations/2026-10-01-1-a1b2-trip.yaml': {
    content: `id: 2026-10-01-1-a1b2\ntitle: Trip\nmodel: mlx/qwen\ncreated: '2026-10-01T09:00:00.000Z'\nupdated: '2026-10-02T09:00:00.000Z'\nprivate: true\nmessages:\n${longMessages}`,
    mtime: 1_759_000_000_000,
  },
  // Legacy layout: title/updated after the messages, so outside the header.
  'conversations/2024-01-05-2-old-budget-review.yaml': {
    content: `id: 2024-01-05-2\ncreated: '2024-01-05T09:00:00.000Z'\nmessages:\n${longMessages}title: Old\n`,
    mtime: 1_704_500_000_000,
  },
  'conversations/_background.yaml': { content: 'id: _background\nmessages: []\n', mtime: 5 },
  'conversations/readme.txt': { content: 'not a conversation', mtime: 5 },
  'tasks/t1.yaml': {
    content: `id: t1\ntitle: Spending audit\nprompt: |\n${'  Audit the week.\n'.repeat(80)}schedule: '0 9 * * 6'\nenabled: true\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-02-01T00:00:00.000Z'\n`,
    mtime: 10,
  },
  'tasks/t2.yaml': {
    content: "id: t2\ntitle: Reading\nprompt: Suggest one paper\nschedule: '0 2 * * *'\ncreated: '2026-03-01T00:00:00.000Z'\n",
    mtime: 11,
  },
  'tasks/no-schedule.yaml': { content: 'id: t3\nprompt: x\n', mtime: 12 },
  'tasks/broken.yaml': { content: 'id: [unclosed\n', mtime: 13 },
  'notes/idea.md': { content: 'An idea', mtime: 1_760_000_000_000 },
  'notes/older.md': { content: 'Older', mtime: 1_750_000_000_000 },
  'skills/writer/SKILL.md': { content: '---\nname: writer\ndescription: Helps write\n---\nBe concise.\n', mtime: 1 },
  'skills/bad/SKILL.md': { content: 'no frontmatter here', mtime: 1 },
  'skills/empty/notes.txt': { content: 'no SKILL.md', mtime: 1 },
};

const rel = (path: string | URL) => String(path).replace(/^\/+/, '');

function children(dir: string | URL) {
  const prefix = rel(dir) ? `${rel(dir)}/` : '';
  const names = new Map<string, boolean>();
  for (const path of Object.keys(VAULT)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split('/');
    names.set(name, rest.length > 0);
  }
  return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
}

const isDir = (path: string | URL) => Object.keys(VAULT).some(p => p.startsWith(`${rel(path)}/`));

/** Serve the fake vault through the per-file /api/fs calls the old path makes. */
function serveFilesystem() {
  vi.mocked(fs.exists).mockImplementation(async path => rel(path) in VAULT || isDir(path));
  vi.mocked(fs.readDir).mockImplementation(async path => children(path));
  vi.mocked(fs.readTextFile).mockImplementation(async path => {
    const file = VAULT[rel(path)];
    if (!file) throw new Error(`not found: ${path}`);
    return file.content;
  });
  vi.mocked(fs.stat).mockImplementation(async path => ({ mtime: new Date(VAULT[rel(path)].mtime) }) as any);
  vi.mocked((fs as any).readDirHeaders).mockImplementation(async (path: string, ext: string, bytes: number) =>
    readDirHeaders({ path, ext, bytes }));
}

/** What readDirHeaders returns for the fake vault. */
function readDirHeaders({ path, ext, bytes }: { path: string; ext: string; bytes: number }) {
  return Object.fromEntries(children(path)
    .filter(entry => entry.isFile && entry.name.endsWith(ext))
    .map(entry => {
      const file = VAULT[`${rel(path)}/${entry.name}`];
      return [entry.name, { content: file.content.slice(0, bytes), mtime: file.mtime }];
    }));
}

/** What GET /api/startup returns for the fake vault (see routes/startup.rs). */
function startupResponse(overrides: Record<string, unknown> = {}) {
  const files = (dir: string, ext: string, bytes?: number) => Object.fromEntries(
    Object.entries(VAULT)
      .filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/') && path.endsWith(ext))
      .map(([path, file]) => [path.slice(dir.length + 1), { content: file.content.slice(0, bytes), mtime: file.mtime }]),
  );
  const skills = Object.fromEntries(
    Object.entries(VAULT)
      .filter(([path]) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
      .map(([path, file]) => [path.split('/')[1], file.content]),
  );
  return {
    complete: true,
    config: { version: 2, providers: [] },
    memory: VAULT['memory.md'],
    conversations: files('conversations', '.yaml', 512),
    notes: files('notes', '.md', 0),
    tasks: files('tasks', '.yaml'),
    skills,
    ...overrides,
  };
}

/** Stub fetch so /api/startup answers `startup`. vault.ts imports
 * readDirHeaders dynamically, which can reach the real HTTP shim past the fs
 * mock, so that route reads the fake vault too. */
function stubServer(startup: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/startup')) return startup();
    if (url.endsWith('/api/fs/readDirHeaders')) {
      return Response.json({ files: readDirHeaders(JSON.parse(String(init!.body))) });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const startupCalls = (fetchMock: ReturnType<typeof stubServer>) =>
  fetchMock.mock.calls.map(([url]) => new URL(url, 'http://alloy.test').pathname);

const byName = <T extends { name: string }>(skills: T[]) => [...skills].sort((a, b) => a.name.localeCompare(b.name));

describe('startup in one request', () => {
  let vault: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    serveFilesystem();
    vault = new VaultService();
    vault.setVaultPath('/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads exactly what the per-file loaders load', async () => {
    const fetchMock = stubServer(() => Response.json(startupResponse()));
    const perFileSkills = new SkillRegistry();
    perFileSkills.setVaultPath('/');
    const [conversations, tasks, notes, , memory] = await Promise.all([
      vault.loadConversationSummaries(),
      vault.loadTasks(),
      vault.loadNotes(),
      perFileSkills.loadSkills(),
      vault.loadMemory(),
    ]);

    fetchMock.mockClear();
    vi.mocked(fs.readTextFile).mockClear();
    const startup = await vault.loadStartup();
    const startupSkills = new SkillRegistry();
    startupSkills.setVaultPath('/');
    await startupSkills.loadSkillFiles(startup!.skillFiles);

    expect(startupCalls(fetchMock)).toEqual(['/api/startup']);
    expect(fs.readTextFile).not.toHaveBeenCalled();
    expect(startup!.conversations).toEqual(conversations);
    expect(startup!.tasks).toEqual(tasks);
    expect(startup!.notes).toEqual(notes);
    expect(startup!.memory).toEqual(memory);
    expect(byName(startupSkills.getSkills())).toEqual(byName(perFileSkills.getSkills()));

    // Guard against both paths agreeing on nothing: the fixture's edge cases
    // must each have come through.
    expect(conversations.map(c => c.title)).toEqual(['Trip', 'old budget review']);
    expect(conversations[0].private).toBe(true);
    expect(tasks.map(t => t.id)).toEqual(['t2', 't1']);
    expect(notes.map(n => n.filename)).toEqual(['idea.md', 'older.md', 'memory.md']);
    expect(memory?.sizeBytes).toBe(new TextEncoder().encode(VAULT['memory.md'].content).length);
    expect(perFileSkills.getSkill('writer')?.instructions).toBe('Be concise.');
    expect(perFileSkills.getSkill('bad')).toBeUndefined();
  });

  it('passes the config through', async () => {
    const config = { version: 2, defaultModel: 'mlx/qwen', providers: [] };
    stubServer(() => Response.json(startupResponse({ config })));
    expect((await vault.loadStartup())?.config).toEqual(config);
  });

  it('leaves a vault that needs setup to the per-file path', async () => {
    stubServer(() => Response.json(startupResponse({ complete: false })));
    expect(await vault.loadStartup()).toBeNull();
  });

  it('falls back when the server has no startup route', async () => {
    stubServer(() => new Response('endpoint not found\n', { status: 404 }));
    expect(await vault.loadStartup()).toBeNull();
  });

  it('falls back when the request fails', async () => {
    stubServer(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await vault.loadStartup()).toBeNull();
  });
});
