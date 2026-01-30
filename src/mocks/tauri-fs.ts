/**
 * Mock implementation of @tauri-apps/plugin-fs
 *
 * In-memory filesystem for browser-only mode.
 */

import { demoVault, demoDirs } from './demo-data';

// Types matching Tauri's fs plugin
export interface WatchEvent {
  type: WatchEventKind;
  paths: string[];
}

export type WatchEventKind =
  | 'any'
  | 'other'
  | { create: { kind: string } }
  | { modify: { kind: string } }
  | { remove: { kind: string } };

interface DirEntry {
  name: string | null;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface FileMetadata {
  mtime: Date | null;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
}

interface WatchOptions {
  recursive?: boolean;
  delayMs?: number;
}

type WatchCallback = (event: WatchEvent) => void;

/**
 * In-memory filesystem implementation
 */
class InMemoryFS {
  private files: Map<string, string | Uint8Array> = new Map();
  private directories: Set<string> = new Set();
  private mtimes: Map<string, Date> = new Map();
  private watchers: Map<string, Set<WatchCallback>> = new Map();

  constructor() {
    this.loadDemoData();
  }

  private loadDemoData() {
    // Load demo directories
    for (const dir of demoDirs) {
      this.directories.add(dir);
    }

    // Load demo files
    for (const [path, content] of Object.entries(demoVault)) {
      this.files.set(path, content);
      this.mtimes.set(path, new Date());
    }
  }

  private normalizePath(path: string): string {
    return path.replace(/\/+/g, '/');
  }

  private ensureParentDirs(path: string) {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i];
      this.directories.add(current);
    }
  }

  private notifyWatchers(path: string, eventKind: WatchEventKind) {
    for (const [watchPath, callbacks] of this.watchers) {
      if (path.startsWith(watchPath)) {
        const event: WatchEvent = { type: eventKind, paths: [path] };
        for (const callback of callbacks) {
          try {
            callback(event);
          } catch (e) {
            console.error('[MockFS] Watcher callback error:', e);
          }
        }
      }
    }
  }

  async readTextFile(path: string): Promise<string> {
    const normalized = this.normalizePath(path);
    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new Error(`File not found: ${normalized}`);
    }
    if (content instanceof Uint8Array) {
      return new TextDecoder().decode(content);
    }
    return content;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const isNew = !this.files.has(normalized);
    this.ensureParentDirs(normalized);
    this.files.set(normalized, content);
    this.mtimes.set(normalized, new Date());
    this.notifyWatchers(
      normalized,
      isNew ? { create: { kind: 'file' } } : { modify: { kind: 'data' } }
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = this.normalizePath(path);
    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new Error(`File not found: ${normalized}`);
    }
    if (typeof content === 'string') {
      return new TextEncoder().encode(content);
    }
    return content;
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const normalized = this.normalizePath(path);
    const isNew = !this.files.has(normalized);
    this.ensureParentDirs(normalized);
    this.files.set(normalized, content);
    this.mtimes.set(normalized, new Date());
    this.notifyWatchers(
      normalized,
      isNew ? { create: { kind: 'file' } } : { modify: { kind: 'data' } }
    );
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    const normalized = this.normalizePath(path);
    this.directories.add(normalized);
    this.ensureParentDirs(normalized);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const normalized = this.normalizePath(path);
    const entries: DirEntry[] = [];
    const seenNames = new Set<string>();

    // Find files in this directory
    const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const relativePath = filePath.slice(prefix.length);
        const name = relativePath.split('/')[0];
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          const isDir = relativePath.includes('/');
          entries.push({
            name,
            isDirectory: isDir,
            isFile: !isDir,
            isSymlink: false,
          });
        }
      }
    }

    // Find subdirectories
    for (const dirPath of this.directories) {
      if (dirPath.startsWith(prefix)) {
        const relativePath = dirPath.slice(prefix.length);
        const name = relativePath.split('/')[0];
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          entries.push({
            name,
            isDirectory: true,
            isFile: false,
            isSymlink: false,
          });
        }
      }
    }

    return entries;
  }

  async remove(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const existed = this.files.has(normalized);
    this.files.delete(normalized);
    this.mtimes.delete(normalized);
    this.directories.delete(normalized);
    if (existed) {
      this.notifyWatchers(normalized, { remove: { kind: 'file' } });
    }
  }

  async stat(path: string): Promise<FileMetadata> {
    const normalized = this.normalizePath(path);
    const isDir = this.directories.has(normalized);
    const isFile = this.files.has(normalized);

    if (!isDir && !isFile) {
      throw new Error(`Path not found: ${normalized}`);
    }

    const content = this.files.get(normalized);
    const size = content
      ? typeof content === 'string'
        ? content.length
        : content.length
      : 0;

    return {
      mtime: this.mtimes.get(normalized) || null,
      size,
      isDirectory: isDir,
      isFile,
    };
  }

  async watch(
    path: string,
    callback: WatchCallback,
    _options?: WatchOptions
  ): Promise<() => void> {
    const normalized = this.normalizePath(path);
    if (!this.watchers.has(normalized)) {
      this.watchers.set(normalized, new Set());
    }
    this.watchers.get(normalized)!.add(callback);

    // Return unwatch function
    return () => {
      const callbacks = this.watchers.get(normalized);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.watchers.delete(normalized);
        }
      }
    };
  }
}

// Singleton instance
const fs = new InMemoryFS();

// Export functions matching @tauri-apps/plugin-fs API
export const readTextFile = (path: string) => fs.readTextFile(path);
export const writeTextFile = (path: string, content: string) =>
  fs.writeTextFile(path, content);
export const readFile = (path: string) => fs.readFile(path);
export const writeFile = (path: string, content: Uint8Array) =>
  fs.writeFile(path, content);
export const exists = (path: string) => fs.exists(path);
export const mkdir = (path: string, options?: { recursive?: boolean }) =>
  fs.mkdir(path, options);
export const readDir = (path: string) => fs.readDir(path);
export const remove = (path: string) => fs.remove(path);
export const stat = (path: string) => fs.stat(path);
export const watch = (
  path: string,
  callback: WatchCallback,
  options?: WatchOptions
) => fs.watch(path, callback, options);
