import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, exists, mkdir, readDir, remove } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Conversation, Config } from '../types';

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

    if (!(await exists(conversationsPath))) {
      await mkdir(conversationsPath, { recursive: true });
    }

    if (!(await exists(topicsPath))) {
      await mkdir(topicsPath, { recursive: true });
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
# OLLAMA_BASE_URL: http://localhost:11434
`;
      await writeTextFile(configPath, defaultConfigYaml);
    }
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

  async loadMemory(): Promise<string> {
    if (!this.vaultPath) return '';

    const memoryPath = await join(this.vaultPath, 'memory.md');
    if (await exists(memoryPath)) {
      return await readTextFile(memoryPath);
    }

    return '';
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
    };

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const filename = `${conversation.id}.yaml`;
    const filePath = await join(conversationsPath, filename);

    await writeTextFile(filePath, yaml.dump(conversationToSave));

    // Generate markdown preview for Obsidian
    await this.writeMarkdownPreview(conversationToSave);
  }

  private async writeMarkdownPreview(conversation: Conversation): Promise<void> {
    if (!this.vaultPath) return;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const mdFilename = `${conversation.id}.md`;
    const yamlFilename = `${conversation.id}.yaml`;
    const mdFilePath = await join(conversationsPath, mdFilename);

    const frontmatterData: Record<string, unknown> = {
      id: conversation.id,
      created: conversation.created,
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
          return m.content
            .split('\n')
            .map((line, i) => i === 0 ? `> [${role}] ${line}` : `> ${line}`)
            .join('\n');
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

    // Sort by created date, newest first
    return conversations.sort((a, b) =>
      new Date(b.created).getTime() - new Date(a.created).getTime()
    );
  }

  async loadConversation(id: string): Promise<Conversation | null> {
    if (!this.vaultPath) return null;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const filePath = await join(conversationsPath, `${id}.yaml`);

    if (await exists(filePath)) {
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

  async getConversationFilePath(id: string): Promise<string | null> {
    if (!this.vaultPath) return null;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const filePath = await join(conversationsPath, `${id}.yaml`);

    if (await exists(filePath)) {
      return filePath;
    }

    return null;
  }

  generateSlug(title: string): string {
    // Convert title to URL-friendly slug
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .slice(0, 50); // Max 50 chars
  }

  async renameConversation(oldId: string, newTitle: string): Promise<Conversation | null> {
    if (!this.vaultPath) return null;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const oldFilePath = await join(conversationsPath, `${oldId}.yaml`);
    const oldMdFilePath = await join(conversationsPath, `${oldId}.md`);

    if (!(await exists(oldFilePath))) {
      return null;
    }

    // Load the existing conversation
    const content = await readTextFile(oldFilePath);
    const conversation = yaml.load(content) as Conversation;

    // Extract date, time, and hash from the old ID
    // Format: YYYY-MM-DD-HHMM-hash-slug or YYYY-MM-DD-HHMM-hash (if no slug)
    const parts = oldId.split('-');
    const date = `${parts[0]}-${parts[1]}-${parts[2]}`; // YYYY-MM-DD
    const time = parts[3]; // HHMM
    const hash = parts[4]; // 4-char hex

    // Generate new ID with the new slug
    const slug = this.generateSlug(newTitle);
    const newId = `${date}-${time}-${hash}-${slug}`;

    // Update conversation with new ID and title
    const updatedConversation = {
      ...conversation,
      id: newId,
      title: newTitle,
    };

    // Save to new file (this also generates the new markdown preview)
    const newFilePath = await join(conversationsPath, `${newId}.yaml`);
    await writeTextFile(newFilePath, yaml.dump(updatedConversation));
    await this.writeMarkdownPreview(updatedConversation);

    // Remove old files
    await remove(oldFilePath);
    if (await exists(oldMdFilePath)) {
      await remove(oldMdFilePath);
    }

    return updatedConversation;
  }

  async deleteConversation(id: string): Promise<boolean> {
    if (!this.vaultPath) return false;

    const conversationsPath = await join(this.vaultPath, 'conversations');
    const yamlFilePath = await join(conversationsPath, `${id}.yaml`);
    const mdFilePath = await join(conversationsPath, `${id}.md`);

    if (!(await exists(yamlFilePath))) {
      return false;
    }

    await remove(yamlFilePath);
    if (await exists(mdFilePath)) {
      await remove(mdFilePath);
    }

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

  async saveMemory(content: string): Promise<void> {
    if (!this.vaultPath) return;

    const memoryPath = await join(this.vaultPath, 'memory.md');
    await writeTextFile(memoryPath, content);
  }
}

export const vaultService = new VaultService();
