import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove, readFile, writeFile, stat } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Conversation, Config, Attachment, ProviderType, formatModelId, NoteInfo, ScheduledTask, TimelineItem } from '../types';

/**
 * Render the `favoriteModels:` YAML block used by updateFavoriteModels. Kept
 * out of the class so it's pure and unit-testable. Always emits a trailing
 * newline so it composes cleanly with surrounding lines.
 */
function renderFavoritesBlock(keys: string[]): string {
  if (keys.length === 0) {
    return 'favoriteModels: []\n';
  }
  const lines = keys.map(k => `  - ${k}`).join('\n');
  return `favoriteModels:\n${lines}\n`;
}

/**
 * Replace the existing `favoriteModels:` block in raw YAML text with `block`
 * (which already includes its `favoriteModels:` header + items + trailing
 * newline). Walks line by line — regex alternation across YAML's inline-vs-
 * block-list-vs-indented-or-not styles is too fragile, and a previous
 * regex-only attempt orphaned items written with non-indented `- ...` lines.
 *
 * "End of block" = next line that looks like another top-level key
 * (`/^[A-Za-z_][\w-]*:/`) or EOF.
 */
export function spliceFavoritesBlock(existing: string, block: string): string {
  if (existing.trim().length === 0) return block;

  const lines = existing.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^favoriteModels:/.test(lines[i])) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) {
    // Prepend at the top — favorites live alongside defaultModel.
    return block + existing;
  }

  // Find the end of the block: only consume subsequent lines that look like
  // list items (indented or not). Comment-only and blank lines belong to the
  // surrounding context — stop at the first such line. This protects inline
  // comments the user has placed between favoriteModels and the next key.
  let endIdx = startIdx + 1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-/.test(line)) {
      endIdx = i + 1;
      continue;
    }
    // Anything else (key, comment, blank) ends the block.
    break;
  }

  // Splice. `block` ends with \n; drop it if the next surviving line already
  // starts cleanly.
  const before = lines.slice(0, startIdx).join('\n');
  const after = lines.slice(endIdx).join('\n');
  const beforePart = before.length > 0 ? before + '\n' : '';
  return beforePart + block + after;
}

/**
 * Replace a top-level scalar `key: value` line in raw YAML text, preserving
 * every other line (comments, provider templates, formatting). Appends the
 * key if absent. Used for UI-toggled settings that must not clobber the user's
 * hand-written config.yaml comments (saveConfig's full yaml.dump would).
 */
export function spliceScalar(existing: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  if (existing.trim().length === 0) return line + '\n';

  const prefix = `${key}:`;
  const lines = existing.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  // Not found — append at the end.
  const sep = existing.endsWith('\n') ? '' : '\n';
  return existing + sep + line + '\n';
}

/**
 * Extract the core ID (YYYY-MM-DD-HHMM-hash) from a conversation/task filename.
 * Input: "2025-01-14-1430-a1b2-my-topic.yaml" → "2025-01-14-1430-a1b2"
 */
export function extractCoreId(filenameOrId: string): string {
  const name = filenameOrId.replace(/\.yaml$/, '');
  const parts = name.split('-');
  if (parts.length >= 5) {
    return parts.slice(0, 5).join('-');
  }
  return name;
}

export class VaultService {
  // Path used as the base for HTTP/IPC API calls. In server mode this is
  // always '/' because the server already owns the vault root; in pre-Phase-2
  // Tauri it was the absolute filesystem path.
  private vaultPath: string | null = null;
  // Absolute filesystem path to the vault. Used for OS-level operations
  // (reveal in Finder, opening config.yaml in an editor) and for telling
  // the embedded server which directory to bind to. Returned by
  // getVaultPath() so existing call sites display/operate on the real path.
  private absoluteVaultPath: string | null = null;

  async selectVaultFolder(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select Alloy Vault Folder',
    });

    if (!selected || typeof selected !== 'string') {
      return null;
    }

    // In Tauri, the embedded server needs to know which folder to bind to
    // before any /api/fs/* call can resolve. Without this, the subsequent
    // initializeVault() and loadConfig() calls fail with PathTraversal
    // because the absolute path the user picked sits outside whatever
    // vault (if any) was previously bound.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { setEmbeddedVaultPath } = await import('./tauri-bootstrap');
      await setEmbeddedVaultPath(selected);
    }

    this.setVaultPath(selected);
    await this.initializeVault(selected);
    return selected;
  }

  async initializeVault(path: string): Promise<void> {
    // All fs ops go through /api/fs/*, which resolves paths against the
    // server-owned vault root, so they MUST be server-relative (base
    // this.vaultPath === '/'). Using the absolute `path` here would make the
    // server re-root it, creating a doubled vault (vault/Users/.../vault/...).
    // Callers always setVaultPath() before initializeVault(), so vaultPath is
    // set; fall back to the absolute path only if it somehow isn't.
    const base = this.vaultPath ?? path;
    // Ensure all directories and default files exist in parallel
    const dirs = [
      await join(base, 'conversations'),
      await join(base, 'skills'),
      await join(base, 'notes'),
      await join(base, 'tasks'),
      await join(base, 'conversations', 'attachments'),
    ];
    const memoryPath = await join(base, 'memory.md');

    await Promise.all([
      ...dirs.map(async (dir) => {
        if (!(await exists(dir))) {
          await mkdir(dir, { recursive: true });
        }
      }),
      (async () => {
        if (!(await exists(memoryPath))) {
          const defaultMemory = `# Memory

## About me
- Add information about yourself here

## Preferences
- Add your preferences here
`;
          await writeTextFile(memoryPath, defaultMemory);
        }
      })(),
    ]);

    // Create config.yaml if it doesn't exist
    const configPath = await join(base, 'config.yaml');
    if (!(await exists(configPath))) {
      // Create config with commented templates for providers
      const defaultConfigYaml = `defaultModel: anthropic/claude-sonnet-4-6

# Uncomment and fill in to enable each provider
# ANTHROPIC_API_KEY: sk-ant-...
# OPENAI_API_KEY: sk-...
# GEMINI_API_KEY: ...
# XAI_API_KEY: xai-...
# OPENROUTER_API_KEY: sk-or-v1-...
# OLLAMA_BASE_URL: http://localhost:11434

# Use your Claude Pro/Max subscription via the Claude Code CLI (text-only;
# bills your subscription, not API credits). Requires the \`claude\` binary
# installed and logged in to your subscription (run \`claude\` once to log in).
# CLAUDE_SUBSCRIPTION: true
# CLAUDE_CODE_PATH: /opt/homebrew/bin/claude   # only if \`claude\` isn't on PATH
# CLAUDE_CODE_OAUTH_TOKEN: sk-ant-oat-...       # from \`claude setup-token\` (optional)

# API keys for skills
# SERPER_API_KEY: ...

# Speech-to-text (Soniox) for dictation
# SONIOX_API_KEY: ...

# External services. Email lets scheduled tasks notify you when they run
# (set \`email: true\` on a task). Only Resend is supported.
# services:
#   email:
#     provider: resend
#     api_key: re_...
#     from: Alloy <alloy@your-domain.com>
#     to: you@example.com
`;
      await writeTextFile(configPath, defaultConfigYaml);
    }

  }

  async getSkillsPath(): Promise<string | null> {
    if (!this.vaultPath) return null;
    return await join(this.vaultPath, 'skills');
  }

  async loadConfig(): Promise<Config | null> {
    if (!this.vaultPath) return null;

    const configPath = await join(this.vaultPath, 'config.yaml');
    if (await exists(configPath)) {
      const content = await readTextFile(configPath);
      const config = yaml.load(content) as Config;
      return config;
    }

    return null;
  }

  async saveConfig(config: Config): Promise<void> {
    if (!this.vaultPath) return;

    const configPath = await join(this.vaultPath, 'config.yaml');
    await writeTextFile(configPath, yaml.dump(config));
  }

  /**
   * Update only the `favoriteModels:` array in config.yaml, preserving every
   * other line (comments, provider templates, formatting). saveConfig() above
   * does a full yaml.dump that would obliterate the user's hand-written
   * comments — not OK for a frequently-toggled UI affordance like the star
   * button in the model picker.
   */
  async updateFavoriteModels(keys: string[]): Promise<void> {
    if (!this.vaultPath) return;

    const configPath = await join(this.vaultPath, 'config.yaml');
    let existing = '';
    if (await exists(configPath)) {
      existing = await readTextFile(configPath);
    }

    const next = spliceFavoritesBlock(existing, renderFavoritesBlock(keys));
    await writeTextFile(configPath, next);
  }

  /**
   * Update a single top-level scalar in config.yaml, preserving comments and
   * other keys (unlike saveConfig's full yaml.dump). For UI-toggled settings.
   */
  async updateConfigValue(key: string, value: string): Promise<void> {
    if (!this.vaultPath) return;

    const configPath = await join(this.vaultPath, 'config.yaml');
    let existing = '';
    if (await exists(configPath)) {
      existing = await readTextFile(configPath);
    }

    await writeTextFile(configPath, spliceScalar(existing, key, value));
  }

  /**
   * Atomically update a conversation: load fresh from disk, apply update function, save back.
   * This prevents race conditions where stale in-memory state overwrites fresher disk state.
   *
   * @param id - The conversation ID
   * @param updateFn - Function that receives the fresh conversation and returns the updated version.
   *                   The function is responsible for merging - it can preserve or overwrite fields as needed.
   * @returns The updated conversation, or null if not found
   */
  async updateConversation(
    id: string,
    updateFn: (fresh: Conversation) => Conversation
  ): Promise<Conversation | null> {
    if (!this.vaultPath) return null;

    // Load fresh from disk
    const fresh = await this.loadConversation(id);
    if (!fresh) return null;

    // Apply the update
    const updated = updateFn(fresh);

    // Save back to disk
    await this.saveConversation(updated);

    return updated;
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    if (!this.vaultPath) return;

    // Filter out empty or undefined messages (can happen when aborting a streaming response).
    // Keep messages that carry attachments even when their text content is empty
    // (e.g. an image sent with no accompanying text).
    const filteredMessages = conversation.messages.filter(
      m => m && (m.content?.trim() !== '' || (m.attachments?.length ?? 0) > 0),
    );

    // Don't save conversations with no actual messages
    if (filteredMessages.length === 0) return;

    // Force `messages` to the end and drop the runtime-only `messagesLoaded`
    // flag, so the metadata stays a compact header block that
    // loadConversationSummaries can read from just the top of the file.
    const conversationToSave: Record<string, unknown> = { ...conversation };
    delete conversationToSave.messagesLoaded;
    delete conversationToSave.messages;
    conversationToSave.messages = filteredMessages;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const newFilename = this.generateFilename(conversation.id, conversation.title);
    const newFilePath = await join(conversationsPath, newFilename);

    // Check if there's an existing file with a different name (title changed)
    const existingFile = await this.findConversationFile(conversation.id);
    if (existingFile && existingFile !== newFilePath) {
      // Remove old yaml and md files
      await remove(existingFile);
      const oldMdFile = existingFile.replace(/\.yaml$/, '.md');
      if (await exists(oldMdFile)) {
        await remove(oldMdFile);
      }
    }

    await writeTextFile(newFilePath, yaml.dump(conversationToSave));

    // Generate markdown preview for Obsidian
    await this.writeMarkdownPreview(conversationToSave as unknown as Conversation);
  }

  private async writeMarkdownPreview(conversation: Conversation): Promise<void> {
    if (!this.vaultPath) return;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const baseFilename = this.generateFilename(conversation.id, conversation.title).replace(/\.yaml$/, '');
    const mdFilename = `${baseFilename}.md`;
    const yamlFilename = `${baseFilename}.yaml`;
    const mdFilePath = await join(conversationsPath, mdFilename);

    const frontmatterData: Record<string, unknown> = {
      id: conversation.id,
      created: conversation.created,
      updated: conversation.updated,
      model: conversation.model,
      title: conversation.title,
    };

    const frontmatter = yaml.dump(frontmatterData);

    // Standard single-model conversation
    const assistantName = conversation.model;  // Already in "provider/model" format
    const messages = conversation.messages
        .filter(m => m.role !== 'log')
        .map(m => {
          const role = m.role === 'user' ? 'You' : assistantName;
          let content = m.content
            .split('\n')
            .map((line, i) => i === 0 ? `> [${role}] ${line}` : `> ${line}`)
            .join('\n');

          // Add image embeds for Obsidian
          if (m.attachments?.length) {
            const imageEmbeds = m.attachments
              .filter(a => a.type === 'image')
              .map(a => {
                // Convert attachments/convid-img-001.png to ![[convid-img-001.png]]
                const filename = a.path.split('/').pop();
                return `![[${filename}]]`;
              })
              .join('\n');
            if (imageEmbeds) {
              content = content + '\n>\n> ' + imageEmbeds.split('\n').join('\n> ');
            }
          }

          return content;
        })
        .join('\n\n');

    const content = `---\n${frontmatter}---\n\n<!-- Auto-generated preview. Edits will be overwritten. Source: ${yamlFilename} -->\n\n${messages}\n`;

    await writeTextFile(mdFilePath, content);
  }

  async loadConversations(): Promise<Conversation[]> {
    if (!this.vaultPath) return [];

    const conversationsPath = await join(this.vaultPath, 'conversations');

    if (!(await exists(conversationsPath))) {
      return [];
    }

    const entries = await readDir(conversationsPath);
    const yamlEntries = entries.filter(e => e.name?.endsWith('.yaml'));

    const results = await Promise.all(
      yamlEntries.map(async (entry) => {
        try {
          const filePath = await join(conversationsPath, entry.name!);
          const content = await readTextFile(filePath);
          const conversation = yaml.load(content) as Conversation;
          this.migrateConversationFormat(conversation);
          return conversation;
        } catch (error) {
          console.error(`[VaultService] Failed to load conversation ${entry.name}:`, error);
          return null;
        }
      })
    );
    const conversations = results.filter((c): c is Conversation => c !== null);

    // Keep files created by the removed background-mode feature out of the timeline.
    const filtered = conversations.filter(c => c.id !== '_background' && !c.id.startsWith('_background-'));

    // Sort by updated date, newest first (fall back to created for older conversations)
    return filtered.sort((a, b) =>
      new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
    );
  }

  /**
   * Lightweight conversation list for the sidebar: one batched header read
   * (top ~512 bytes of each YAML) instead of loading every message. Metadata
   * (id/title/model/created/updated) always precedes `messages:`, so the header
   * block parses on its own. Full messages are loaded lazily on open via
   * [loadConversation]. Turns ~1000 file reads + 190MB parse into one request.
   */
  async loadConversationSummaries(): Promise<Conversation[]> {
    if (!this.vaultPath) return [];

    const conversationsPath = await join(this.vaultPath, 'conversations');
    if (!(await exists(conversationsPath))) return [];

    const { readDirHeaders } = await import('@tauri-apps/plugin-fs') as any;
    const headers: Record<string, { content: string; mtime: number }> =
      await readDirHeaders(conversationsPath, '.yaml', 512);

    const summaries: Conversation[] = [];
    for (const [name, { content, mtime }] of Object.entries(headers)) {
      // The header read is truncated mid-file, so the messages array is
      // incomplete/unparseable — parse only the metadata block before `messages:`.
      const headerBlock = content.split(/^messages:/m)[0];
      let meta: Partial<Conversation> = {};
      try {
        meta = (yaml.load(headerBlock) as Partial<Conversation>) ?? {};
      } catch {
        meta = {};
      }
      const id = meta.id ?? name.replace(/\.yaml$/, '');
      if (!id) continue;
      // Legacy files stored title/updated AFTER the messages array (so they're
      // absent from the header). Fall back to the filename slug for the title
      // and the file mtime for the timestamps — the old slugged title is
      // essentially the de-slugified id anyway.
      const isoMtime = new Date(mtime).toISOString();
      summaries.push({
        id,
        created: meta.created ?? isoMtime,
        updated: meta.updated ?? isoMtime,
        model: meta.model ?? '',
        title: meta.title ?? this.deriveTitleFromFilename(name),
        messages: [],
        messagesLoaded: false,
      });
    }

    const filtered = summaries.filter(
      c => c.id !== '_background' && !c.id.startsWith('_background-')
    );
    return filtered.sort((a, b) =>
      new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
    );
  }

  /** Human title derived from a conversation filename/id when the header lacks
   * one (legacy metadata-last files). Strips the leading `YYYY-MM-DD-<num>-`
   * date/id prefix and de-slugifies the rest. */
  private deriveTitleFromFilename(name: string): string {
    const base = name.replace(/\.yaml$/, '');
    // Strip the `YYYY-MM-DD-<timestamp>-` (and optional 4-hex id hash) prefix
    // used by both id formats, leaving the slugged title.
    const slug = base.replace(/^\d{4}-\d{2}-\d{2}-\d+-(?:[0-9a-f]{4}-)?/, '');
    const title = slug.replace(/-/g, ' ').trim();
    return title || 'Untitled conversation';
  }

  async loadConversation(id: string): Promise<Conversation | null> {
    if (!this.vaultPath) return null;

    // Find file by core ID (handles files with slugs)
    const filePath = await this.findConversationFile(id);

    if (filePath && await exists(filePath)) {
      const content = await readTextFile(filePath);
      const conversation = yaml.load(content) as Conversation;
      // Migrate old provider/model fields if needed.
      this.migrateConversationFormat(conversation);
      return conversation;
    }

    return null;
  }

  /** Load all canonical scheduled tasks from tasks/. */
  async loadTasks(): Promise<ScheduledTask[]> {
    if (!this.vaultPath) return [];

    const tasksPath = await join(this.vaultPath, 'tasks');
    if (!(await exists(tasksPath))) return [];

    const entries = await readDir(tasksPath);
    const results = await Promise.all(
      entries.filter(entry => entry.name?.endsWith('.yaml')).map(async (entry) => {
        try {
          const content = await readTextFile(await join(tasksPath, entry.name!));
          const task = yaml.load(content) as ScheduledTask;
          return task?.id && task?.prompt && task?.schedule ? task : null;
        } catch (error) {
          console.error(`[VaultService] Failed to load task ${entry.name}:`, error);
          return null;
        }
      })
    );
    return results
      .filter((task): task is ScheduledTask => task !== null)
      .sort((a, b) => new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime());
  }

  async findTaskFile(id: string): Promise<string | null> {
    if (!this.vaultPath) return null;
    const tasksPath = await join(this.vaultPath, 'tasks');
    if (!(await exists(tasksPath))) return null;

    for (const entry of await readDir(tasksPath)) {
      if (entry.name?.endsWith('.yaml') &&
          (entry.name === `${id}.yaml` || entry.name.startsWith(`${id}-`))) {
        return await join(tasksPath, entry.name);
      }
    }
    return null;
  }

  async saveTask(task: ScheduledTask): Promise<void> {
    if (!this.vaultPath) return;
    const tasksPath = await join(this.vaultPath, 'tasks');
    if (!(await exists(tasksPath))) await mkdir(tasksPath, { recursive: true });
    const existingFile = await this.findTaskFile(task.id);
    await writeTextFile(existingFile || await join(tasksPath, `${task.id}.yaml`), yaml.dump(task));
  }

  async loadTask(id: string): Promise<ScheduledTask | null> {
    if (!this.vaultPath) return null;
    const filePath = await this.findTaskFile(id);
    if (!filePath) return null;
    try {
      return yaml.load(await readTextFile(filePath)) as ScheduledTask;
    } catch (error) {
      console.error(`[VaultService] Failed to load task ${id}:`, error);
      return null;
    }
  }

  async deleteTask(id: string): Promise<boolean> {
    if (!this.vaultPath) return false;
    const filePath = await this.findTaskFile(id);
    if (!filePath) return false;
    await remove(filePath);
    return true;
  }

  async updateTask(
    id: string,
    updateFn: (fresh: ScheduledTask) => ScheduledTask
  ): Promise<ScheduledTask | null> {
    if (!this.vaultPath) return null;
    const fresh = await this.loadTask(id);
    if (!fresh) return null;
    const updated = updateFn(fresh);
    await this.saveTask(updated);
    return updated;
  }

  /**
   * Migrate old conversation format to new unified model format.
   * Old format: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" }
   * New format: { model: "anthropic/claude-sonnet-4-5-20250929" }
   * Modifies the conversation in place.
   */
  private migrateConversationFormat(conversation: Conversation): void {
    const conv = conversation as any;

    // Migrate top-level provider/model to unified model string
    if (conv.provider && !conv.model?.includes('/')) {
      conv.model = formatModelId(conv.provider as ProviderType, conv.model || '');
      delete conv.provider;
    }

    // Migrate message-level provider/model
    if (conv.messages) {
      for (const msg of conv.messages) {
        if (msg.provider && msg.model && !msg.model.includes('/')) {
          msg.model = formatModelId(msg.provider, msg.model);
          delete msg.provider;
        }
      }
    }
  }

  setVaultPath(path: string): void {
    // Always remember the absolute path for OS ops and display.
    this.absoluteVaultPath = path;
    // API calls go through HTTP /api/fs/* which resolves relative to the
    // server-owned vault root, so path-joining uses '/' as the base.
    this.vaultPath = '/';
  }

  getVaultPath(): string | null {
    // External callers (reveal in finder, openPath on config.yaml, display
    // in Settings) want the absolute filesystem path.
    return this.absoluteVaultPath ?? this.vaultPath;
  }

  async ensureRiffsDirectory(): Promise<string | null> {
    if (!this.vaultPath) return null;

    const riffsPath = await join(this.vaultPath, 'riffs');
    if (!(await exists(riffsPath))) {
      await mkdir(riffsPath, { recursive: true });
    }
    return riffsPath;
  }

  extractConversationIdFromPath(filePath: string): string | null {
    const filename = filePath.split('/').pop() || '';
    if (!filename.endsWith('.yaml')) return null;
    // Extract core ID (date-time-hash) from filename
    return this.extractCoreId(filename);
  }

  /**
   * Public getters return ABSOLUTE filesystem paths because their callers
   * (revealItemInDir, openPath, markSelfWrite vs. native watcher events)
   * need to talk to the OS. Internal helpers (`findConversationFile` etc.)
   * keep returning server-relative paths for use in /api/fs/* calls.
   */
  async getConversationFilePath(id: string): Promise<string | null> {
    const rel = await this.findConversationFile(id);
    return rel ? this.toAbsolute(rel) : null;
  }

  async getTaskFilePath(id: string): Promise<string | null> {
    const rel = await this.findTaskFile(id);
    return rel ? this.toAbsolute(rel) : null;
  }

  /** Map a server-relative vault path (e.g. "/conversations/foo.yaml") to
   *  an absolute filesystem path, if we know the absolute vault root. */
  private toAbsolute(relative: string): string {
    if (!this.absoluteVaultPath) return relative;
    const trimmed = relative.replace(/^\/+/, '');
    return `${this.absoluteVaultPath.replace(/\/+$/, '')}/${trimmed}`;
  }

  generateSlug(title: string): string {
    // Convert title to URL-friendly slug
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .slice(0, 50); // Max 50 chars
  }

  extractCoreId(filenameOrId: string): string {
    return extractCoreId(filenameOrId);
  }

  // Generate filename with optional slug
  generateFilename(id: string, title?: string): string {
    if (title) {
      const slug = this.generateSlug(title);
      return slug ? `${id}-${slug}.yaml` : `${id}.yaml`;
    }
    return `${id}.yaml`;
  }

  // Find conversation file by core ID (searches for files starting with the ID)
  async findConversationFile(id: string): Promise<string | null> {
    if (!this.vaultPath) return null;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    if (!(await exists(conversationsPath))) return null;

    const entries = await readDir(conversationsPath);

    // Look for exact match first, then prefix match
    for (const entry of entries) {
      if (entry.name?.endsWith('.yaml')) {
        const filename = entry.name;
        // Check if this file's core ID matches
        if (filename === `${id}.yaml` || filename.startsWith(`${id}-`)) {
          return await join(conversationsPath, filename);
        }
      }
    }

    return null;
  }

  async renameConversation(id: string, newTitle: string): Promise<Conversation | null> {
    if (!this.vaultPath) return null;

    // Find existing file by core ID
    const oldFilePath = await this.findConversationFile(id);
    if (!oldFilePath) {
      return null;
    }

    const oldMdFilePath = oldFilePath.replace(/\.yaml$/, '.md');

    // Load the existing conversation
    const content = await readTextFile(oldFilePath);
    const conversation = yaml.load(content) as Conversation;

    // ID stays the same - only title and filename change
    const updatedConversation = {
      ...conversation,
      title: newTitle,
    };

    // Save with new filename (saveConversation handles file rename)
    await this.saveConversation(updatedConversation);

    // Remove old md file if it exists (yaml is handled by saveConversation)
    if (await exists(oldMdFilePath)) {
      const newMdFilePath = oldFilePath.replace(/\.yaml$/, '.md').replace(
        oldFilePath.split('/').pop()!.replace('.yaml', ''),
        this.generateFilename(id, newTitle).replace('.yaml', '')
      );
      if (oldMdFilePath !== newMdFilePath && await exists(oldMdFilePath)) {
        await remove(oldMdFilePath);
      }
    }

    return updatedConversation;
  }

  async deleteConversation(id: string): Promise<boolean> {
    if (!this.vaultPath) return false;

    // Find file by core ID (handles files with slugs)
    const yamlFilePath = await this.findConversationFile(id);

    if (!yamlFilePath) {
      return false;
    }

    // Derive md file path from yaml path
    const mdFilePath = yamlFilePath.replace(/\.yaml$/, '.md');

    await remove(yamlFilePath);
    if (await exists(mdFilePath)) {
      await remove(mdFilePath);
    }

    // Also delete any attachments for this conversation
    await this.deleteConversationAttachments(id);

    return true;
  }

  async getMemoryFilePath(): Promise<string | null> {
    if (!this.vaultPath) return null;

    const memoryPath = await join(this.vaultPath, 'memory.md');
    if (await exists(memoryPath)) {
      return memoryPath;
    }

    return null;
  }

  /**
   * Load memory.md content and size.
   * Returns null if no vault or memory file doesn't exist.
   */
  async loadMemory(): Promise<{ content: string; sizeBytes: number } | null> {
    if (!this.vaultPath) return null;

    const memoryPath = await join(this.vaultPath, 'memory.md');
    if (!(await exists(memoryPath))) return null;

    const content = await readTextFile(memoryPath);
    const sizeBytes = new TextEncoder().encode(content).length;

    return { content, sizeBytes };
  }

  async getConfigFilePath(): Promise<string | null> {
    if (!this.vaultPath) return null;

    // Use the API-relative path to check existence (works in both modes),
    // but return the absolute filesystem path so callers (e.g. openPath)
    // can hand it to the OS.
    const apiPath = await join(this.vaultPath, 'config.yaml');
    if (!(await exists(apiPath))) return null;
    if (this.absoluteVaultPath) {
      return await join(this.absoluteVaultPath, 'config.yaml');
    }
    return apiPath;
  }

  // Note handling methods

  getNotesPath(): string | null {
    if (!this.vaultPath) return null;
    return `${this.vaultPath}/notes`;
  }

  /**
   * Server-relative API path for a note filename, used for all /api/fs/*
   * operations (read/write/exists/remove). memory.md and riffs/ live at the
   * vault root; regular notes under notes/. This is the path the server
   * resolves against its own vault root — it MUST stay relative (base
   * this.vaultPath === '/'). Passing an absolute path here makes the server
   * re-root it under the vault, producing a doubled path
   * (vault/Users/.../vault/memory.md). Use getNoteFilePath() for the absolute
   * form needed by OS-level ops (markSelfWrite, reveal).
   */
  private async noteApiPath(filename: string): Promise<string | null> {
    if (!this.vaultPath) return null;
    return filename === 'memory.md' || filename.startsWith('riffs/')
      ? await join(this.vaultPath, filename)
      : await join(this.vaultPath, 'notes', filename);
  }

  async getNoteFilePath(filename: string): Promise<string | null> {
    const rel = await this.noteApiPath(filename);
    return rel ? this.toAbsolute(rel) : null;
  }

  /**
   * Read a note's content via its server-relative path (correct in both Tauri
   * and web mode). Returns null if no vault is open or the file doesn't exist.
   */
  async readNote(filename: string): Promise<string | null> {
    const apiPath = await this.noteApiPath(filename);
    if (!apiPath || !(await exists(apiPath))) return null;
    return await readTextFile(apiPath);
  }

  /**
   * Overwrite a note's full content via its server-relative path (correct in
   * both Tauri and web mode). Returns false if no vault is open.
   */
  async writeNote(filename: string, content: string): Promise<boolean> {
    const apiPath = await this.noteApiPath(filename);
    if (!apiPath) return false;
    await writeTextFile(apiPath, content);
    return true;
  }

  async deleteNote(filename: string): Promise<boolean> {
    const notePath = await this.noteApiPath(filename);
    if (!notePath) return false;

    if (await exists(notePath)) {
      await remove(notePath);
      return true;
    }
    return false;
  }

  async renameRiff(oldFilename: string, newName: string): Promise<string | null> {
    if (!this.vaultPath) return null;
    if (!oldFilename.startsWith('riffs/')) return null;

    // Sanitize new name - remove .md if provided, sanitize for filesystem
    const sanitizedName = newName
      .replace(/\.md$/, '')
      .replace(/[/\\:*?"<>|]/g, '-')
      .trim();

    if (!sanitizedName) return null;

    const oldPath = await join(this.vaultPath, oldFilename);
    const newFilename = `riffs/${sanitizedName}.md`;
    const newPath = await join(this.vaultPath, newFilename);

    // Don't rename if same name
    if (oldFilename === newFilename) return oldFilename;

    // Check if target already exists
    if (await exists(newPath)) return null;

    // Read content, write to new path, delete old
    if (await exists(oldPath)) {
      const content = await readTextFile(oldPath);
      await writeTextFile(newPath, content);
      await remove(oldPath);
      return newFilename;
    }

    return null;
  }

  async loadNotes(): Promise<NoteInfo[]> {
    if (!this.vaultPath) {
      return [];
    }

    const notes: NoteInfo[] = [];

    // Check for memory.md at vault root (always first)
    const memoryPath = await join(this.vaultPath, 'memory.md');
    if (await exists(memoryPath)) {
      const fileStat = await stat(memoryPath);
      const lastModified = fileStat.mtime ? new Date(fileStat.mtime).getTime() : 0;
      const content = await readTextFile(memoryPath);
      notes.push({
        filename: 'memory.md',
        lastModified,
        hasSkillContent: false,
        content,
      });
    }

    const notesPath = await join(this.vaultPath, 'notes');

    // Auto-create notes directory if missing
    if (!(await exists(notesPath))) {
      await mkdir(notesPath, { recursive: true });
      return notes; // Return just memory.md if notes dir is empty
    }

    // Batch-read all note bodies in one HTTP request (mtime + content), so the
    // sidebar can full-text search note bodies. The byte cap is generous enough
    // to cover real notes in full; longer notes are searchable up to the cap.
    const { readDirHeaders } = await import('@tauri-apps/plugin-fs') as any;
    const noteHeaders: Record<string, { content: string; mtime: number }> =
      await readDirHeaders(notesPath, '.md', 1_000_000);
    for (const [name, { content, mtime }] of Object.entries(noteHeaders)) {
      notes.push({ filename: name, lastModified: mtime, hasSkillContent: false, content });
    }

    // Load riff notes from riffs/ directory — batch-read all headers in one HTTP request.
    const riffsPath = await join(this.vaultPath, 'riffs');
    if (await exists(riffsPath)) {
      const headers: Record<string, { content: string; mtime: number }> = await readDirHeaders(riffsPath, '.md', 300);
      for (const [name, { content, mtime }] of Object.entries(headers)) {
        const lastModified = mtime;
        const riffInfo = this.parseRiffFrontmatter(name, content, lastModified);
        notes.push(riffInfo);
      }
    }

    // Sort by lastModified descending (newest first)
    return notes.sort((a, b) => b.lastModified - a.lastModified);
  }

  private parseRiffFrontmatter(name: string, content: string, lastModified: number): NoteInfo {
    let isIntegrated = false;
    let title: string | undefined;
    let artifactType: 'note' | 'mermaid' | undefined;
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      try {
        const frontmatter = yaml.load(frontmatterMatch[1]) as Record<string, unknown>;
        isIntegrated = frontmatter.integrated === true;
        if (typeof frontmatter.title === 'string') {
          title = frontmatter.title;
        }
        if (frontmatter.artifactType === 'note' || frontmatter.artifactType === 'mermaid') {
          artifactType = frontmatter.artifactType;
        }
      } catch {
        // Ignore frontmatter parse errors
      }
    }
    return {
      filename: `riffs/${name}`,
      lastModified,
      hasSkillContent: false,
      isRiff: true,
      isIntegrated,
      title,
      artifactType,
    };
  }

  /**
   * Build a unified timeline of all content types, sorted by last updated.
   * Returns conversations, notes (excluding riffs), scheduled tasks, and riffs.
   */
  buildTimeline(
    conversations: Conversation[],
    notes: NoteInfo[],
    tasks: ScheduledTask[]
  ): TimelineItem[] {
    const items: TimelineItem[] = [];

    // Add conversations
    for (const conv of conversations) {
      // Get last message preview
      const lastMessage = conv.messages.filter(m => m.role !== 'log').pop();
      const preview = lastMessage?.content?.slice(0, 100) || '';

      items.push({
        type: 'conversation',
        id: conv.id,
        title: conv.title || 'New conversation',
        lastUpdated: new Date(conv.updated || conv.created).getTime(),
        preview,
        conversation: conv,
      });
    }

    // Add notes (separate regular notes from riffs)
    for (const note of notes) {
      if (note.isRiff) {
        // Riff items - title is the filename without extension
        const title = note.filename.replace('riffs/', '').replace('.md', '');

        items.push({
          type: 'riff',
          id: note.filename,
          title,
          lastUpdated: note.lastModified,
          preview: note.isIntegrated ? 'Integrated' : 'Draft',
          note,
        });
      } else {
        // Regular note items
        items.push({
          type: 'note',
          id: note.filename,
          title: note.filename.replace('.md', ''),
          lastUpdated: note.lastModified,
          note,
        });
      }
    }

    // Add scheduled tasks. Skipped checks don't reorder the timeline; delivered
    // output is the meaningful activity timestamp.
    for (const task of tasks) {
      const deliveredAt = task.lastDeliveredAt
        ? new Date(task.lastDeliveredAt).getTime()
        : 0;
      const preview = task.enabled
        ? (deliveredAt ? `Last delivered: ${new Date(deliveredAt).toLocaleDateString()}` : 'Awaiting first result')
        : 'Disabled';

      items.push({
        type: 'task',
        id: task.id,
        title: task.title,
        lastUpdated: deliveredAt || new Date(task.created).getTime(),
        preview,
        task,
      });
    }

    // Sort by lastUpdated descending (newest first)
    return items.sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  async loadRawConfig(): Promise<string> {
    if (!this.vaultPath) return '';

    const configPath = await join(this.vaultPath, 'config.yaml');
    if (await exists(configPath)) {
      return await readTextFile(configPath);
    }

    return '';
  }

  async saveRawConfig(content: string): Promise<{ success: boolean; error?: string }> {
    if (!this.vaultPath) {
      return { success: false, error: 'No vault path set' };
    }

    // Validate YAML syntax
    try {
      yaml.load(content);
    } catch (e) {
      return { success: false, error: `Invalid YAML: ${(e as Error).message}` };
    }

    const configPath = await join(this.vaultPath, 'config.yaml');
    await writeTextFile(configPath, content);
    return { success: true };
  }

  // Image handling methods

  async getAttachmentsPath(): Promise<string | null> {
    if (!this.vaultPath) return null;
    return await join(this.vaultPath, 'conversations', 'attachments');
  }

  async getNextImageFilename(conversationId: string, extension: string): Promise<string> {
    const attachmentsPath = await this.getAttachmentsPath();
    if (!attachmentsPath) return `${conversationId}-img-001.${extension}`;

    if (!(await exists(attachmentsPath))) {
      return `${conversationId}-img-001.${extension}`;
    }

    const entries = await readDir(attachmentsPath);
    const prefix = `${conversationId}-img-`;
    const imageNumbers = entries
      .filter(e => e.name?.startsWith(prefix))
      .map(e => {
        const match = e.name?.match(/-img-(\d+)\./);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => !isNaN(n));

    const nextNum = imageNumbers.length > 0 ? Math.max(...imageNumbers) + 1 : 1;
    return `${conversationId}-img-${String(nextNum).padStart(3, '0')}.${extension}`;
  }

  async saveImage(conversationId: string, imageData: Uint8Array, mimeType: string): Promise<Attachment> {
    const attachmentsPath = await this.getAttachmentsPath();
    if (!attachmentsPath) {
      throw new Error('No vault path set');
    }

    // Ensure attachments directory exists
    if (!(await exists(attachmentsPath))) {
      await mkdir(attachmentsPath, { recursive: true });
    }

    const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1] || 'png';
    const filename = await this.getNextImageFilename(conversationId, extension);
    const filePath = await join(attachmentsPath, filename);

    await writeFile(filePath, imageData);

    return {
      type: 'image',
      path: `attachments/${filename}`,
      mimeType,
    };
  }

  async loadImageAsBase64(relativePath: string): Promise<string> {
    if (!this.vaultPath) {
      throw new Error('No vault path set');
    }

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const fullPath = await join(conversationsPath, relativePath);

    const data = await readFile(fullPath);
    // Convert Uint8Array to base64
    let binary = '';
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async getImageAbsolutePath(relativePath: string): Promise<string | null> {
    if (!this.vaultPath) return null;
    const conversationsPath = await join(this.vaultPath, 'conversations');
    return await join(conversationsPath, relativePath);
  }

  async deleteConversationAttachments(conversationId: string): Promise<void> {
    const attachmentsPath = await this.getAttachmentsPath();
    if (!attachmentsPath || !(await exists(attachmentsPath))) return;

    const entries = await readDir(attachmentsPath);
    const prefix = `${conversationId}-`;

    for (const entry of entries) {
      if (entry.name?.startsWith(prefix)) {
        const filePath = await join(attachmentsPath, entry.name);
        await remove(filePath);
      }
    }
  }

  async renameConversationAttachments(oldId: string, newId: string): Promise<void> {
    const attachmentsPath = await this.getAttachmentsPath();
    if (!attachmentsPath || !(await exists(attachmentsPath))) return;

    const entries = await readDir(attachmentsPath);
    const prefix = `${oldId}-`;

    for (const entry of entries) {
      if (entry.name?.startsWith(prefix)) {
        const oldPath = await join(attachmentsPath, entry.name);
        const newFilename = entry.name.replace(prefix, `${newId}-`);
        const newPath = await join(attachmentsPath, newFilename);

        // Read and write to new location, then delete old
        const data = await readFile(oldPath);
        await writeFile(newPath, data);
        await remove(oldPath);
      }
    }
  }
}

export const vaultService = new VaultService();
