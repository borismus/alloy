// Test setup file for Vitest
import { vi } from 'vitest';

// Mock Tauri APIs since they won't work in Node.js test environment
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn((...parts: string[]) => parts.join('/')),
}));
