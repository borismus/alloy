import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Message, NoteInfo, ProposedChange, getProviderFromModel, getModelIdFromModel } from '../types';
import { providerRegistry } from './providers';

interface RambleHistoryFile {
  messages: Message[];
}

const MAX_MESSAGES = 50;
const RAMBLE_FILENAME = 'ramble_history.yaml';

// Terse system prompt for action-focused responses
export const RAMBLE_SYSTEM_PROMPT = `You are a quick-action assistant. Be extremely terse. Focus on doing, not explaining.

Rules:
- Respond in 1-2 sentences max unless showing code/results
- Prefer tool use over explanation
- Skip pleasantries and acknowledgments
- Just do the task, don't narrate
- If asked to do something, do it immediately
- Only explain if explicitly asked`;

export class RambleService {
  private vaultPath: string | null = null;

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  getVaultPath(): string | null {
    return this.vaultPath;
  }

  async getRambleFilePath(): Promise<string | null> {
    if (!this.vaultPath) return null;
    return await join(this.vaultPath, RAMBLE_FILENAME);
  }

  async loadHistory(): Promise<Message[]> {
    if (!this.vaultPath) return [];

    const filePath = await this.getRambleFilePath();
    if (!filePath || !(await exists(filePath))) {
      return [];
    }

    try {
      const content = await readTextFile(filePath);
      const data = yaml.load(content) as RambleHistoryFile;
      return data?.messages || [];
    } catch (error) {
      console.error('[RambleService] Failed to load history:', error);
      return [];
    }
  }

  async saveHistory(messages: Message[]): Promise<void> {
    if (!this.vaultPath) return;

    const filePath = await this.getRambleFilePath();
    if (!filePath) return;

    // Keep only the last MAX_MESSAGES
    const trimmedMessages = messages.slice(-MAX_MESSAGES);

    const data: RambleHistoryFile = {
      messages: trimmedMessages,
    };

    try {
      await writeTextFile(filePath, yaml.dump(data));
    } catch (error) {
      console.error('[RambleService] Failed to save history:', error);
    }
  }

  async addMessage(message: Message): Promise<void> {
    const history = await this.loadHistory();
    history.push(message);
    await this.saveHistory(history);
  }

  async clearHistory(): Promise<void> {
    await this.saveHistory([]);
  }

  // Get or create a timestamped ramble note
  async getOrCreateRambleNote(): Promise<string> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    // Ensure rambles directory exists
    const ramblesPath = await join(this.vaultPath, 'rambles');
    if (!(await exists(ramblesPath))) {
      await mkdir(ramblesPath, { recursive: true });
    }

    // Generate timestamp-based filename: YYYY-MM-DD-HHMMSS.md
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const filename = `rambles/${date}-${time}.md`;

    const fullPath = await join(this.vaultPath, filename);

    // Create the file with a header
    const initialContent = `# Ramble - ${now.toLocaleDateString()} ${now.toLocaleTimeString()}\n\n`;
    await writeTextFile(fullPath, initialContent);

    return filename;
  }

  // Process user input and append to ramble note
  async processRambleInput(
    input: string,
    rambleNotePath: string,
    existingNotes: NoteInfo[],
    model: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const providerType = getProviderFromModel(model);
    const modelId = getModelIdFromModel(model);
    const provider = providerRegistry.getProvider(providerType);

    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${providerType} not initialized`);
    }

    // Read existing ramble note content for context
    const fullPath = await join(this.vaultPath, rambleNotePath);
    let existingContent = '';
    if (await exists(fullPath)) {
      existingContent = await readTextFile(fullPath);
    }

    // Build notes list for wikilink suggestions
    const notesList = existingNotes
      .filter(n => !n.filename.startsWith('rambles/'))
      .map(n => n.filename.replace('.md', ''))
      .join(', ');

    const systemPrompt = `You are helping capture the user's stream of consciousness. Process this new chunk of their rambling into clear, structured markdown.

Rules:
- Add [[wikilinks]] to existing notes when referencing related concepts
- Structure with headers, bullets as appropriate
- Be concise - capture the essence
- This will be APPENDED to the note, so don't repeat prior content
- Output ONLY the processed content (no meta-commentary)

Existing notes in vault: ${notesList}
Previous processed content (for context): ${existingContent.slice(-1000)}`;

    const messages: Message[] = [
      { role: 'user', timestamp: new Date().toISOString(), content: `New raw input to process:\n\n${input}` }
    ];

    // Stream the response
    let processedContent = '';
    await provider.sendMessage(messages, {
      model: modelId,
      onChunk: (chunk: string) => {
        processedContent += chunk;
      },
      signal,
      systemPrompt,
    });

    // Append to the ramble note
    if (processedContent.trim()) {
      const updatedContent = existingContent + '\n' + processedContent.trim() + '\n';
      await writeTextFile(fullPath, updatedContent);
    }
  }

  // Generate integration proposals for other notes
  async generateIntegrationProposal(
    rambleNotePath: string,
    existingNotes: NoteInfo[],
    model: string
  ): Promise<ProposedChange[]> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const providerType = getProviderFromModel(model);
    const modelId = getModelIdFromModel(model);
    const provider = providerRegistry.getProvider(providerType);

    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${providerType} not initialized`);
    }

    // Read ramble note content
    const fullPath = await join(this.vaultPath, rambleNotePath);
    const rambleContent = await readTextFile(fullPath);

    // Read content of existing notes for context
    const notesWithContent: { filename: string; content: string }[] = [];
    for (const note of existingNotes.slice(0, 10)) { // Limit to 10 notes for context
      if (note.filename.startsWith('rambles/')) continue;
      try {
        const notePath = note.filename === 'memory.md'
          ? await join(this.vaultPath, note.filename)
          : await join(this.vaultPath, 'notes', note.filename);
        const content = await readTextFile(notePath);
        notesWithContent.push({ filename: note.filename, content: content.slice(0, 500) }); // Truncate for context
      } catch {
        // Skip notes that can't be read
      }
    }

    const notesContext = notesWithContent
      .map(n => `## ${n.filename}\n${n.content}`)
      .join('\n\n');

    // Extract just the filename without path for provenance
    const rambleFilename = rambleNotePath.split('/').pop()?.replace('.md', '') || rambleNotePath;

    const systemPrompt = `You are analyzing a ramble note and proposing specific changes to integrate key insights into other notes.

Return ONLY a valid JSON array of proposed changes. Each object must have:
- "type": "append" | "update" | "create"
- "path": filename (e.g., "notes/topic.md" or "memory.md")
- "description": brief description of the change
- "newContent": the actual content to add (with [[wikilinks]] and provenance marker)
- "reasoning": why this integration makes sense

Rules:
- Prefer appending to existing notes over creating new ones
- Add provenance marker at the end: &[[rambles/${rambleFilename}]]
- Only propose meaningful integrations - don't force it
- If no good integrations exist, return an empty array []

Return ONLY the JSON array, no other text.`;

    const messages: Message[] = [
      {
        role: 'user',
        timestamp: new Date().toISOString(),
        content: `Ramble content:\n\n${rambleContent}\n\nExisting notes:\n\n${notesContext}`
      }
    ];

    let response = '';
    await provider.sendMessage(messages, {
      model: modelId,
      onChunk: (chunk: string) => {
        response += chunk;
      },
      systemPrompt,
    });

    // Parse JSON response
    try {
      // Extract JSON array from response (handle potential markdown code blocks)
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const proposals = JSON.parse(jsonMatch[0]) as ProposedChange[];
        return proposals;
      }
      return [];
    } catch (error) {
      console.error('[RambleService] Failed to parse integration proposals:', error);
      return [];
    }
  }

  // Apply approved changes to notes
  async applyProposedChanges(changes: ProposedChange[], vaultPath: string): Promise<void> {
    for (const change of changes) {
      try {
        const notePath = change.path.startsWith('notes/') || change.path === 'memory.md'
          ? await join(vaultPath, change.path)
          : await join(vaultPath, 'notes', change.path);

        if (change.type === 'create') {
          // Create new file
          await writeTextFile(notePath, change.newContent);
        } else if (change.type === 'append') {
          // Append to existing file
          let existingContent = '';
          if (await exists(notePath)) {
            existingContent = await readTextFile(notePath);
          }
          const updatedContent = existingContent.trimEnd() + '\n\n' + change.newContent;
          await writeTextFile(notePath, updatedContent);
        } else if (change.type === 'update') {
          // Replace entire file content
          await writeTextFile(notePath, change.newContent);
        }
      } catch (error) {
        console.error(`[RambleService] Failed to apply change to ${change.path}:`, error);
      }
    }
  }
}

export const rambleService = new RambleService();
