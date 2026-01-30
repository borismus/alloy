/**
 * Mock implementation of @tauri-apps/api/path
 *
 * Provides browser-compatible path utilities.
 */

export async function join(...parts: string[]): Promise<string> {
  return parts
    .filter((p) => p && p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

export async function basename(path: string): Promise<string> {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

export async function dirname(path: string): Promise<string> {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

export async function extname(path: string): Promise<string> {
  const base = await basename(path);
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(dotIndex) : '';
}
