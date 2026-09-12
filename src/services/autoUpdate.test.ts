import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoUpdate,
  isServerIdle,
  runAutoUpdateCycle,
  setAutoUpdate,
  type AutoUpdateDeps,
} from './autoUpdate';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('auto-update preference', () => {
  it('is off unless explicitly enabled', () => {
    // Opt-in: an unattended relaunch should never be a surprise default.
    expect(getAutoUpdate()).toBe(false);
  });

  it('round-trips through localStorage', () => {
    setAutoUpdate(true);
    expect(getAutoUpdate()).toBe(true);
    setAutoUpdate(false);
    expect(getAutoUpdate()).toBe(false);
  });

  it('is per-machine, not stored in the synced vault config', () => {
    // The vault is synced between machines, so a vault-level flag would force
    // the same behavior everywhere — the opposite of the intent.
    setAutoUpdate(true);
    expect(localStorage.getItem('alloy.autoUpdate')).toBe('true');
  });

  it('treats unavailable localStorage as opt-out rather than throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(getAutoUpdate()).toBe(false);
  });

  it('does not throw when the preference cannot be persisted', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setAutoUpdate(true)).not.toThrow();
  });
});

describe('server idle check', () => {
  const mockFetch = (impl: () => unknown) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => impl()));
  };

  afterEach(() => vi.unstubAllGlobals());

  it('is idle only when the backend reports nothing in flight', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ busy: false, streamingSessions: 0, runningTasks: 0 }),
    }));
    expect(await isServerIdle()).toBe(true);

    mockFetch(() => ({
      ok: true,
      json: async () => ({ busy: true, streamingSessions: 0, runningTasks: 1 }),
    }));
    expect(await isServerIdle()).toBe(false);
  });

  it('treats an unreachable or failing server as busy', async () => {
    // Guessing "idle" here would restart the app mid-task.
    mockFetch(() => { throw new Error('connection refused'); });
    expect(await isServerIdle()).toBe(false);

    mockFetch(() => ({ ok: false, json: async () => ({}) }));
    expect(await isServerIdle()).toBe(false);

    mockFetch(() => ({ ok: true, json: async () => { throw new Error('not json'); } }));
    expect(await isServerIdle()).toBe(false);
  });
});

describe('unattended update cycle', () => {
  let deps: AutoUpdateDeps<{ version: string }> & {
    enabled: ReturnType<typeof vi.fn>;
    findUpdate: ReturnType<typeof vi.fn>;
    isIdle: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
    relaunch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    deps = {
      enabled: vi.fn().mockReturnValue(true),
      findUpdate: vi.fn().mockResolvedValue({ version: '0.4.27' }),
      isIdle: vi.fn().mockResolvedValue(true),
      install: vi.fn().mockResolvedValue(undefined),
      relaunch: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('does nothing at all when the machine has not opted in', async () => {
    deps.enabled.mockReturnValue(false);
    expect(await runAutoUpdateCycle(deps)).toBe('disabled');
    expect(deps.findUpdate).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('installs and restarts when idle', async () => {
    expect(await runAutoUpdateCycle(deps)).toBe('installed');
    expect(deps.install).toHaveBeenCalledWith({ version: '0.4.27' });
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('stays put when there is no update', async () => {
    deps.findUpdate.mockResolvedValue(null);
    expect(await runAutoUpdateCycle(deps)).toBe('none');
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('downloads nothing while the server is busy', async () => {
    deps.isIdle.mockResolvedValue(false);
    expect(await runAutoUpdateCycle(deps)).toBe('busy-before-install');
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('does not restart when work starts during the download', async () => {
    // The race the second idle check exists for: idle when we began, busy by
    // the time the bytes landed.
    deps.isIdle.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await runAutoUpdateCycle(deps)).toBe('busy-after-install');
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('restarts a staged update later without downloading it again', async () => {
    expect(await runAutoUpdateCycle({ ...deps, pendingInstall: true })).toBe('installed');
    expect(deps.findUpdate).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('keeps deferring a staged update while the machine stays busy', async () => {
    deps.isIdle.mockResolvedValue(false);
    expect(await runAutoUpdateCycle({ ...deps, pendingInstall: true })).toBe('busy-after-install');
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('reports failures instead of restarting', async () => {
    deps.install.mockRejectedValue(new Error('signature mismatch'));
    expect(await runAutoUpdateCycle(deps)).toBe('error');
    expect(deps.relaunch).not.toHaveBeenCalled();

    deps.install.mockResolvedValue(undefined);
    deps.install.mockClear();
    deps.findUpdate.mockRejectedValue(new Error('offline'));
    expect(await runAutoUpdateCycle(deps)).toBe('error');
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});
