/**
 * Runtime-aware shim for @tauri-apps/plugin-updater.
 *
 * Inside Tauri (window has __TAURI_INTERNALS__), reimplements the real
 * plugin's `invoke` contract directly — importing `invoke`/`Channel` from
 * `@tauri-apps/api/core` (which is NOT aliased in vite.config.ts) so the
 * bundled desktop app gets working update checks and installs. In a pure
 * browser it degrades to "no update available".
 *
 * NOTE: must never `import '@tauri-apps/plugin-updater'` — vite.config.ts
 * aliases that specifier back to this file, which would loop.
 */

import { isTauri } from './index';

export interface DownloadEvent {
  event: 'Started' | 'Progress' | 'Finished';
  data: {
    contentLength?: number;
    chunkLength?: number;
  };
}

export interface Update {
  version: string;
  currentVersion?: string;
  date?: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

async function core() {
  return import('@tauri-apps/api/core');
}

class TauriUpdate implements Update {
  rid: number;
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;

  constructor(metadata: UpdateMetadata) {
    this.rid = metadata.rid;
    this.version = metadata.version;
    this.currentVersion = metadata.currentVersion;
    this.date = metadata.date;
    this.body = metadata.body;
  }

  async downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void> {
    const { invoke, Channel } = await core();
    const channel = new Channel<DownloadEvent>();
    if (onEvent) channel.onmessage = onEvent;
    await invoke('plugin:updater|download_and_install', {
      onEvent: channel,
      rid: this.rid,
    });
  }
}

export async function check(): Promise<Update | null> {
  if (!isTauri()) return null;
  const { invoke } = await core();
  const metadata = await invoke<UpdateMetadata | null>('plugin:updater|check', {});
  return metadata ? new TauriUpdate(metadata) : null;
}
