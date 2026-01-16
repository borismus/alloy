import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Conversation, Config, Attachment } from '../types';

export class VaultService {
  private vaultPath: string | null = null;

  async selectVaultFolder(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select PromptBox Vault Folder',
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
    const topicsPath = await join(path, 'topics');
    const skillsPath = await join(path, 'skills');

    if (!(await exists(conversationsPath))) {
      await mkdir(conversationsPath, { recursive: true });
    }

    if (!(await exists(topicsPath))) {
      await mkdir(topicsPath, { recursive: true });
    }

    if (!(await exists(skillsPath))) {
      await mkdir(skillsPath, { recursive: true });
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
      const defaultConfigYaml = `vaultPath: ${path}
defaultModel: claude-opus-4-5-20251101

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

    // Create default skills if they don't exist
    await this.initializeDefaultSkills(path);
  }

  async initializeDefaultSkills(vaultPath: string): Promise<void> {
    const skillsPath = await join(vaultPath, 'skills');

    // Memory skill
    const memorySkillPath = await join(skillsPath, 'memory');
    if (!(await exists(memorySkillPath))) {
      await mkdir(memorySkillPath, { recursive: true });
      const memorySkillMd = `---
name: memory
description: Read memory.md at conversation start. Save new memories to the SAME file.
---

# Memory Skill

## Reading (do this FIRST in every conversation)

Call \`read_file\` with path \`memory.md\` before responding to the user's first message.

## Saving (when user asks to remember something)

1. First read the current \`memory.md\`
2. Then call \`write_file\` with path \`memory.md\` and the COMPLETE updated content

**CRITICAL:** Only use the file \`memory.md\`. Never create other files like \`notes/\`, \`preferences.md\`, etc. All memories go in \`memory.md\`.
`;
      await writeTextFile(await join(memorySkillPath, 'SKILL.md'), memorySkillMd);
    }

    // Web search skill
    const webSearchSkillPath = await join(skillsPath, 'web-search');
    if (!(await exists(webSearchSkillPath))) {
      await mkdir(webSearchSkillPath, { recursive: true });
      const webSearchSkillMd = `---
name: web-search
description: Search the web for current information, news, or real-time data.
---

# Web Search Skill

When the user asks about current events, recent news, or information that may have
changed since your knowledge cutoff:

1. Use \`get_secret\` with key "SERPER_API_KEY" to get the API key
2. Use \`http_post\` to search:
   - url: "https://google.serper.dev/search"
   - body: {"q": "your search query"}
   - headers: {"X-API-KEY": "[key from step 1]"}

Parse the JSON response and summarize the top results. Cite sources when relevant.
`;
      await writeTextFile(await join(webSearchSkillPath, 'SKILL.md'), webSearchSkillMd);
    }

    // Read URL skill
    const readUrlSkillPath = await join(skillsPath, 'read-url');
    if (!(await exists(readUrlSkillPath))) {
      await mkdir(readUrlSkillPath, { recursive: true });
      const readUrlSkillMd = `---
name: read-url
description: Read and summarize content from URLs the user shares.
---

# URL Reader Skill

When the user shares a URL or asks you to read a webpage, use \`http_get\` to fetch it.

Extract the main content and provide a summary. If the page is very long, focus on
the most relevant sections based on the user's question.
`;
      await writeTextFile(await join(readUrlSkillPath, 'SKILL.md'), readUrlSkillMd);
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

      // Ensure vaultPath matches the actual path (may have been moved)
      if (config.vaultPath !== this.vaultPath) {
        config.vaultPath = this.vaultPath;
        await this.saveConfig(config);
      }

      return config;
    }

    return null;
  }

  async saveConfig(config: Config): Promise<void> {
    if (!this.vaultPath) return;

    const configPath = await join(this.vaultPath, 'config.yaml');
    await writeTextFile(configPath, yaml.dump(config));
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    if (!this.vaultPath) return;

    // Filter out empty messages (can happen when aborting a streaming response)
    const filteredMessages = conversation.messages.filter(m => m.content.trim() !== '');

    // Don't save conversations with no actual messages
    if (filteredMessages.length === 0) return;

    const conversationToSave = {
      ...conversation,
      messages: filteredMessages,
      updated: new Date().toISOString(),
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
      frontmatterData.models = conversation.comparison.models.map(m => `${m.provider}/${m.model}`);
    }

    const frontmatter = yaml.dump(frontmatterData);

    let messages: string;

    if (conversation.comparison) {
      // Format comparison conversations differently
      const modelCount = conversation.comparison.models.length;
      const modelNames = conversation.comparison.models.map(m => `${m.provider}/${m.model}`);

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
      const assistantName = `${conversation.provider}/${conversation.model}`;
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
      return yaml.load(content) as Conversation;
    }

    return null;
  }

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  getVaultPath(): string | null {
    return this.vaultPath;
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
