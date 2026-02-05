import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove, readFile, writeFile, stat } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Conversation, Config, Attachment, ProviderType, formatModelId, NoteInfo, Trigger, TimelineItem } from '../types';

export class VaultService {
  private vaultPath: string | null = null;

  async selectVaultFolder(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select Orchestra Vault Folder',
    });

    if (selected && typeof selected === 'string') {
      this.vaultPath = selected;
      await this.initializeVault(selected);
      return selected;
    }

    return null;
  }

  async initializeVault(path: string): Promise<void> {
    // Create necessary directories
    const conversationsPath = await join(path, 'conversations');
    const skillsPath = await join(path, 'skills');

    if (!(await exists(conversationsPath))) {
      await mkdir(conversationsPath, { recursive: true });
    }

    if (!(await exists(skillsPath))) {
      await mkdir(skillsPath, { recursive: true });
    }

    // Create notes directory for AI-managed notes
    const notesPath = await join(path, 'notes');
    if (!(await exists(notesPath))) {
      await mkdir(notesPath, { recursive: true });
    }

    // Create triggers directory for trigger logs
    const triggersPath = await join(path, 'triggers');
    if (!(await exists(triggersPath))) {
      await mkdir(triggersPath, { recursive: true });
    }

    // Create attachments directory for images
    const attachmentsPath = await join(path, 'conversations', 'attachments');
    if (!(await exists(attachmentsPath))) {
      await mkdir(attachmentsPath, { recursive: true });
    }

    // Create memory.md if it doesn't exist
    const memoryPath = await join(path, 'memory.md');
    if (!(await exists(memoryPath))) {
      const defaultMemory = `# Memory

## About me
- Add information about yourself here

## Preferences
- Add your preferences here
`;
      await writeTextFile(memoryPath, defaultMemory);
    }

    // Create config.yaml if it doesn't exist
    const configPath = await join(path, 'config.yaml');
    if (!(await exists(configPath))) {
      // Create config with commented templates for providers
      const defaultConfigYaml = `defaultModel: anthropic/claude-opus-4-5-20251101

# Uncomment and fill in to enable each provider
# ANTHROPIC_API_KEY: sk-ant-...
# OPENAI_API_KEY: sk-...
# GEMINI_API_KEY: ...
# OLLAMA_BASE_URL: http://localhost:11434

# API keys for skills
# SERPER_API_KEY: ...
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

    // Filter out empty or undefined messages (can happen when aborting a streaming response)
    const filteredMessages = conversation.messages.filter(m => m && m.content?.trim() !== '');

    // Don't save conversations with no actual messages (unless it's a trigger conversation)
    if (filteredMessages.length === 0 && !conversation.trigger) return;

    const conversationToSave = {
      ...conversation,
      messages: filteredMessages,
    };

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
    await this.writeMarkdownPreview(conversationToSave);
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

    // Add comparison metadata to frontmatter if this is a comparison
    if (conversation.comparison) {
      frontmatterData.comparison = true;
      frontmatterData.models = conversation.comparison.models;  // Already in "provider/model" format
    }

    const frontmatter = yaml.dump(frontmatterData);

    let messages: string;

    if (conversation.comparison) {
      // Format comparison conversations differently
      const modelCount = conversation.comparison.models.length;
      const modelNames = conversation.comparison.models;  // Already in "provider/model" format

      // Group messages by user prompt
      const groups: { userMessage: string; responses: string[] }[] = [];
      let i = 0;
      const nonLogMessages = conversation.messages.filter(m => m.role !== 'log');

      while (i < nonLogMessages.length) {
        const msg = nonLogMessages[i];
        if (msg.role === 'user') {
          const responses: string[] = [];
          for (let j = 0; j < modelCount && i + 1 + j < nonLogMessages.length; j++) {
            const nextMsg = nonLogMessages[i + 1 + j];
            if (nextMsg.role === 'assistant') {
              responses.push(nextMsg.content);
            }
          }
          groups.push({ userMessage: msg.content, responses });
          i += 1 + responses.length;
        } else {
          i++;
        }
      }

      messages = groups.map(group => {
        const userBlock = group.userMessage
          .split('\n')
          .map((line, i) => i === 0 ? `> [You] ${line}` : `> ${line}`)
          .join('\n');

        const responseBlocks = group.responses.map((response, idx) => {
          const modelName = modelNames[idx] || `Model ${idx + 1}`;
          return response
            .split('\n')
            .map((line, i) => i === 0 ? `> [${modelName}] ${line}` : `> ${line}`)
            .join('\n');
        }).join('\n\n');

        return `${userBlock}\n\n${responseBlocks}`;
      }).join('\n\n---\n\n');
    } else {
      // Standard single-model conversation
      const assistantName = conversation.model;  // Already in "provider/model" format
      messages = conversation.messages
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
    }

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
    const conversations: Conversation[] = [];

    for (const entry of entries) {
      if (entry.name?.endsWith('.yaml')) {
        const filePath = await join(conversationsPath, entry.name);
        const content = await readTextFile(filePath);
        const conversation = yaml.load(content) as Conversation;
        // Migrate old trigger format if needed
        this.migrateConversationFormat(conversation);
        conversations.push(conversation);
      }
    }

    // Sort by updated date, newest first (fall back to created for older conversations)
    return conversations.sort((a, b) =>
      new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
    );
  }

  async loadConversation(id: string): Promise<Conversation | null> {
    if (!this.vaultPath) return null;

    // Find file by core ID (handles files with slugs)
    const filePath = await this.findConversationFile(id);

    if (filePath && await exists(filePath)) {
      const content = await readTextFile(filePath);
      const conversation = yaml.load(content) as Conversation;
      // Migrate old trigger format if needed
      this.migrateConversationFormat(conversation);
      return conversation;
    }

    return null;
  }

  /**
   * Load all triggers from the triggers/ directory.
   * Excludes logs.yaml which is used for trigger execution history.
   */
  async loadTriggers(): Promise<Trigger[]> {
    if (!this.vaultPath) return [];

    const triggersPath = await join(this.vaultPath, 'triggers');

    if (!(await exists(triggersPath))) {
      return [];
    }

    const entries = await readDir(triggersPath);
    const triggers: Trigger[] = [];

    for (const entry of entries) {
      // Skip logs.yaml and non-yaml files
      if (!entry.name?.endsWith('.yaml') || entry.name === 'logs.yaml') {
        continue;
      }

      try {
        const filePath = await join(triggersPath, entry.name);
        const content = await readTextFile(filePath);
        const trigger = yaml.load(content) as Trigger;

        // Basic validation - ensure required fields exist
        if (trigger.id && trigger.trigger?.triggerPrompt) {
          triggers.push(trigger);
        }
      } catch (error) {
        console.error(`[VaultService] Failed to load trigger ${entry.name}:`, error);
      }
    }

    // Sort by updated date, newest first
    return triggers.sort((a, b) =>
      new Date(b.updated || b.created).getTime() - new Date(a.updated || a.created).getTime()
    );
  }

  /**
   * Find a trigger file by its ID, handling files with slugs in the filename.
   */
  async findTriggerFile(id: string): Promise<string | null> {
    if (!this.vaultPath) return null;

    const triggersPath = await join(this.vaultPath, 'triggers');
    if (!(await exists(triggersPath))) return null;

    const entries = await readDir(triggersPath);

    for (const entry of entries) {
      if (entry.name?.endsWith('.yaml') && entry.name !== 'logs.yaml') {
        if (entry.name === `${id}.yaml` || entry.name.startsWith(`${id}-`)) {
          return await join(triggersPath, entry.name);
        }
      }
    }

    return null;
  }

  /**
   * Save a trigger to the triggers/ directory.
   * Preserves existing filename if the trigger already exists.
   */
  async saveTrigger(trigger: Trigger): Promise<void> {
    if (!this.vaultPath) return;

    const triggersPath = await join(this.vaultPath, 'triggers');

    if (!(await exists(triggersPath))) {
      await mkdir(triggersPath, { recursive: true });
    }

    // Use existing file path if it exists (preserves slug)
    const existingFile = await this.findTriggerFile(trigger.id);
    const filePath = existingFile || await join(triggersPath, `${trigger.id}.yaml`);

    await writeTextFile(filePath, yaml.dump(trigger));
  }

  /**
   * Load a single trigger by ID.
   */
  async loadTrigger(id: string): Promise<Trigger | null> {
    if (!this.vaultPath) return null;

    const filePath = await this.findTriggerFile(id);

    if (filePath) {
      try {
        const content = await readTextFile(filePath);
        return yaml.load(content) as Trigger;
      } catch (error) {
        console.error(`[VaultService] Failed to load trigger ${id}:`, error);
      }
    }

    return null;
  }

  /**
   * Atomically update a trigger: load fresh from disk, apply update function, save back.
   */
  async updateTrigger(
    id: string,
    updateFn: (fresh: Trigger) => Trigger
  ): Promise<Trigger | null> {
    if (!this.vaultPath) return null;

    const fresh = await this.loadTrigger(id);
    if (!fresh) return null;

    const updated = updateFn(fresh);
    await this.saveTrigger(updated);

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

    // Migrate comparison metadata
    if (conv.comparison?.models) {
      conv.comparison.models = conv.comparison.models.map((m: any) => {
        if (typeof m === 'object' && m.provider && m.model) {
          return formatModelId(m.provider, m.model);
        }
        return m; // Already a string
      });
    }

    // Migrate council metadata
    if (conv.council) {
      if (conv.council.councilMembers) {
        conv.council.councilMembers = conv.council.councilMembers.map((m: any) => {
          if (typeof m === 'object' && m.provider && m.model) {
            return formatModelId(m.provider, m.model);
          }
          return m;
        });
      }
      if (conv.council.chairman && typeof conv.council.chairman === 'object') {
        const chairman = conv.council.chairman as any;
        if (chairman.provider && chairman.model) {
          conv.council.chairman = formatModelId(chairman.provider, chairman.model);
        }
      }
    }

    // Migrate message-level provider/model (for comparison/council messages)
    if (conv.messages) {
      for (const msg of conv.messages) {
        if (msg.provider && msg.model && !msg.model.includes('/')) {
          msg.model = formatModelId(msg.provider, msg.model);
          delete msg.provider;
        }
      }
    }

    // Migrate trigger format
    const trigger = conv.trigger;
    if (trigger) {
      // Old format: triggerProvider + triggerModel → triggerModel (unified)
      if (trigger.triggerProvider && !trigger.triggerModel?.includes('/')) {
        trigger.triggerModel = formatModelId(trigger.triggerProvider, trigger.triggerModel);
        delete trigger.triggerProvider;
      }
      if (trigger.mainProvider && !trigger.mainModel?.includes('/')) {
        trigger.mainModel = formatModelId(trigger.mainProvider, trigger.mainModel);
        delete trigger.mainProvider;
      }

      // New simplified format: triggerModel/mainModel → model
      // Prefer mainModel (quality) over triggerModel (cheap) since we now use a single model
      if (!trigger.model) {
        trigger.model = trigger.mainModel || trigger.triggerModel;
      }
      // Clean up old fields
      delete trigger.triggerModel;
      delete trigger.mainModel;
      delete trigger.mainPrompt;
    }
  }

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  getVaultPath(): string | null {
    return this.vaultPath;
  }

  async ensureRamblesDirectory(): Promise<string | null> {
    if (!this.vaultPath) return null;

    const ramblesPath = await join(this.vaultPath, 'rambles');
    if (!(await exists(ramblesPath))) {
      await mkdir(ramblesPath, { recursive: true });
    }
    return ramblesPath;
  }

  extractConversationIdFromPath(filePath: string): string | null {
    const filename = filePath.split('/').pop() || '';
    if (!filename.endsWith('.yaml')) return null;
    // Extract core ID (date-time-hash) from filename
    return this.extractCoreId(filename);
  }

  async getConversationFilePath(id: string): Promise<string | null> {
    // Find file by core ID (handles files with slugs)
    return await this.findConversationFile(id);
  }

  async getTriggerFilePath(id: string): Promise<string | null> {
    // Find file by core ID (handles files with slugs)
    return await this.findTriggerFile(id);
  }

  generateSlug(title: string): string {
    // Convert title to URL-friendly slug
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .slice(0, 50); // Max 50 chars
  }

  // Extract the core ID (date-time-hash) from a filename or full ID
  // Input: "2025-01-14-1430-a1b2-my-topic.yaml" or "2025-01-14-1430-a1b2-my-topic" or "2025-01-14-1430-a1b2"
  // Output: "2025-01-14-1430-a1b2"
  extractCoreId(filenameOrId: string): string {
    // Remove .yaml extension if present
    const name = filenameOrId.replace(/\.yaml$/, '');
    // Split by dash and take first 5 parts: YYYY-MM-DD-HHMM-hash
    const parts = name.split('-');
    if (parts.length >= 5) {
      return parts.slice(0, 5).join('-');
    }
    return name; // Return as-is if doesn't match expected format
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

  async getConfigFilePath(): Promise<string | null> {
    if (!this.vaultPath) return null;

    const configPath = await join(this.vaultPath, 'config.yaml');
    if (await exists(configPath)) {
      return configPath;
    }

    return null;
  }

  // Note handling methods

  getNotesPath(): string | null {
    if (!this.vaultPath) return null;
    return `${this.vaultPath}/notes`;
  }

  async getNoteFilePath(filename: string): Promise<string | null> {
    if (!this.vaultPath) return null;
    // Rambles are stored at rambles/, regular notes at notes/
    if (filename.startsWith('rambles/')) {
      return await join(this.vaultPath, filename);
    }
    return await join(this.vaultPath, 'notes', filename);
  }

  async deleteNote(filename: string): Promise<boolean> {
    if (!this.vaultPath) return false;

    // Rambles are stored at rambles/, regular notes at notes/
    const notePath = filename.startsWith('rambles/')
      ? await join(this.vaultPath, filename)
      : await join(this.vaultPath, 'notes', filename);

    if (await exists(notePath)) {
      await remove(notePath);
      return true;
    }
    return false;
  }

  async loadNotes(): Promise<NoteInfo[]> {
    if (!this.vaultPath) {
      console.log('[VaultService] loadNotes: No vault path set');
      return [];
    }

    const notes: NoteInfo[] = [];

    // Check for memory.md at vault root (always first)
    const memoryPath = await join(this.vaultPath, 'memory.md');
    if (await exists(memoryPath)) {
      const fileStat = await stat(memoryPath);
      const lastModified = fileStat.mtime ? new Date(fileStat.mtime).getTime() : 0;
      const content = await readTextFile(memoryPath);
      const hasSkillContent = content.includes('&[[');
      notes.push({
        filename: 'memory.md',
        lastModified,
        hasSkillContent,
      });
    }

    const notesPath = await join(this.vaultPath, 'notes');
    console.log('[VaultService] loadNotes: Looking in', notesPath);

    // Auto-create notes directory if missing
    if (!(await exists(notesPath))) {
      await mkdir(notesPath, { recursive: true });
      return notes; // Return just memory.md if notes dir is empty
    }

    const entries = await readDir(notesPath);

    for (const entry of entries) {
      if (entry.name?.endsWith('.md')) {
        const filePath = await join(notesPath, entry.name);

        // Get file stats for modification time
        const fileStat = await stat(filePath);
        const lastModified = fileStat.mtime ? new Date(fileStat.mtime).getTime() : 0;

        // Read file content to check for skill markers
        const content = await readTextFile(filePath);
        const hasSkillContent = content.includes('&[[');

        notes.push({
          filename: entry.name,
          lastModified,
          hasSkillContent,
        });
      }
    }

    // Load ramble notes from rambles/ directory
    const ramblesPath = await join(this.vaultPath, 'rambles');
    if (await exists(ramblesPath)) {
      const rambleEntries = await readDir(ramblesPath);
      for (const entry of rambleEntries) {
        if (entry.name?.endsWith('.md')) {
          const filePath = await join(ramblesPath, entry.name);
          const fileStat = await stat(filePath);
          const lastModified = fileStat.mtime ? new Date(fileStat.mtime).getTime() : 0;
          const content = await readTextFile(filePath);
          const hasSkillContent = content.includes('&[[');

          // Parse frontmatter to get integrated status
          let isIntegrated = false;
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            try {
              const frontmatter = yaml.load(frontmatterMatch[1]) as Record<string, unknown>;
              isIntegrated = frontmatter.integrated === true;
            } catch {
              // Ignore frontmatter parse errors
            }
          }

          notes.push({
            filename: `rambles/${entry.name}`,
            lastModified,
            hasSkillContent,
            isRamble: true,
            isIntegrated,
          });
        }
      }
    }

    // Sort by lastModified descending (newest first)
    const sortedNotes = notes.sort((a, b) => b.lastModified - a.lastModified);
    console.log('[VaultService] loadNotes: Found', sortedNotes.length, 'notes:', sortedNotes.map(n => n.filename));
    return sortedNotes;
  }

  /**
   * Build a unified timeline of all content types, sorted by last updated.
   * Returns conversations, notes (excluding rambles), triggers, and rambles as TimelineItems.
   */
  async buildTimeline(
    conversations: Conversation[],
    notes: NoteInfo[],
    triggers: Trigger[]
  ): Promise<TimelineItem[]> {
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

    // Add notes (separate regular notes from rambles)
    for (const note of notes) {
      if (note.isRamble) {
        // Ramble items
        const dateMatch = note.filename.match(/rambles\/(\d{4}-\d{2}-\d{2})-(\d{6})\.md/);
        const title = dateMatch
          ? `Ramble ${dateMatch[1]} ${dateMatch[2].slice(0, 2)}:${dateMatch[2].slice(2, 4)}`
          : note.filename.replace('rambles/', '').replace('.md', '');

        items.push({
          type: 'ramble',
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

    // Add triggers
    for (const trigger of triggers) {
      const lastFiring = trigger.trigger.lastTriggered
        ? new Date(trigger.trigger.lastTriggered).getTime()
        : 0;
      const preview = trigger.trigger.enabled
        ? (lastFiring ? `Last fired: ${new Date(lastFiring).toLocaleDateString()}` : 'Never fired')
        : 'Disabled';

      items.push({
        type: 'trigger',
        id: trigger.id,
        title: trigger.title,
        lastUpdated: new Date(trigger.updated || trigger.created).getTime(),
        preview,
        trigger,
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
