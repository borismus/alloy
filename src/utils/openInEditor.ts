import { openPath, openUrl } from '@tauri-apps/plugin-opener';

export type ExternalEditor = 'obsidian' | 'system';

/**
 * Open a vault file for editing in the user's chosen external editor.
 *
 * - 'obsidian' opens markdown notes via the `obsidian://open?path=<abs>` URI,
 *   which lets Obsidian locate the containing vault. Non-markdown files (e.g.
 *   config.yaml, conversation/trigger YAML) fall back to the system default
 *   app, since Obsidian only edits markdown.
 * - 'system' always opens with the OS default app.
 *
 * `absolutePath` must be an absolute filesystem path (e.g. from
 * vaultService.getNoteFilePath / getConfigFilePath).
 */
export async function openInEditor(absolutePath: string, editor: ExternalEditor): Promise<void> {
  const isMarkdown = absolutePath.toLowerCase().endsWith('.md');
  if (editor === 'obsidian' && isMarkdown) {
    await openUrl(`obsidian://open?path=${encodeURIComponent(absolutePath)}`);
    return;
  }
  await openPath(absolutePath);
}
