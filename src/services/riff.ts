import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Message, NoteInfo, ProposedChange, RiffArtifactType, getProviderFromModel, getModelIdFromModel } from '../types';
import { providerRegistry } from './providers';

interface RiffHistoryFile {
  messages: Message[];
}

const MAX_MESSAGES = 50;
const RIFF_FILENAME = 'riff_history.yaml';
const RIFF_LOG_FILENAME = 'raw_input';

// Terse system prompt for action-focused responses
export const RIFF_SYSTEM_PROMPT = `You are a quick-action assistant. Be extremely terse. Focus on doing, not explaining.

Rules:
- Respond in 1-2 sentences max unless showing code/results
- Prefer tool use over explanation
- Skip pleasantries and acknowledgments
- Just do the task, don't narrate
- If asked to do something, do it immediately
- Only explain if explicitly asked`;

export class RiffService {
  private vaultPath: string | null = null;

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  getVaultPath(): string | null {
    return this.vaultPath;
  }

  async getRiffFilePath(): Promise<string | null> {
    if (!this.vaultPath) return null;
    return await join(this.vaultPath, RIFF_FILENAME);
  }

  // Get the riff log file path (append-only journal)
  async getRiffLogPath(): Promise<string | null> {
    if (!this.vaultPath) return null;
    const riffsPath = await join(this.vaultPath, 'riffs');
    return await join(riffsPath, RIFF_LOG_FILENAME);
  }

  // Read the entire riff log (append-only journal)
  async getRiffLog(): Promise<string> {
    const logPath = await this.getRiffLogPath();
    if (!logPath || !(await exists(logPath))) {
      return '';
    }
    try {
      return await readTextFile(logPath);
    } catch (error) {
      console.error('[RiffService] Failed to read riff log:', error);
      return '';
    }
  }

  // Write the full log content (replaces file)
  async writeLog(content: string): Promise<void> {
    if (!this.vaultPath) return;

    // Ensure riffs directory exists
    const riffsPath = await join(this.vaultPath, 'riffs');
    if (!(await exists(riffsPath))) {
      await mkdir(riffsPath, { recursive: true });
    }

    const logPath = await this.getRiffLogPath();
    if (!logPath) return;

    try {
      await writeTextFile(logPath, content);
    } catch (error) {
      console.error('[RiffService] Failed to write riff log:', error);
    }
  }

  // Append text to the global log (more efficient than full rewrite)
  async appendToLog(text: string): Promise<void> {
    if (!this.vaultPath || !text) return;

    // Ensure riffs directory exists
    const riffsPath = await join(this.vaultPath, 'riffs');
    if (!(await exists(riffsPath))) {
      await mkdir(riffsPath, { recursive: true });
    }

    const logPath = await this.getRiffLogPath();
    if (!logPath) return;

    try {
      // Read existing content and append
      let existingContent = '';
      if (await exists(logPath)) {
        existingContent = await readTextFile(logPath);
      }
      await writeTextFile(logPath, existingContent + text);
    } catch (error) {
      console.error('[RiffService] Failed to append to riff log:', error);
    }
  }

  async loadHistory(): Promise<Message[]> {
    if (!this.vaultPath) return [];

    const filePath = await this.getRiffFilePath();
    if (!filePath || !(await exists(filePath))) {
      return [];
    }

    try {
      const content = await readTextFile(filePath);
      const data = yaml.load(content) as RiffHistoryFile;
      return data?.messages || [];
    } catch (error) {
      console.error('[RiffService] Failed to load history:', error);
      return [];
    }
  }

  async saveHistory(messages: Message[]): Promise<void> {
    if (!this.vaultPath) return;

    const filePath = await this.getRiffFilePath();
    if (!filePath) return;

    // Keep only the last MAX_MESSAGES
    const trimmedMessages = messages.slice(-MAX_MESSAGES);

    const data: RiffHistoryFile = {
      messages: trimmedMessages,
    };

    try {
      await writeTextFile(filePath, yaml.dump(data));
    } catch (error) {
      console.error('[RiffService] Failed to save history:', error);
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

  // Get or create a timestamped riff note
  async getOrCreateRiffNote(initialRawInput = ''): Promise<string> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    // Ensure riffs directory exists
    const riffsPath = await join(this.vaultPath, 'riffs');
    if (!(await exists(riffsPath))) {
      await mkdir(riffsPath, { recursive: true });
    }

    // Generate timestamp-based filename: YYYY-MM-DD-HHMMSS.md
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const filename = `riffs/${date}-${time}.md`;

    const fullPath = await join(this.vaultPath, filename);

    // Create the file with frontmatter (including rawInput) and header
    // Use YAML literal block scalar for multi-line rawInput
    const rawInputYaml = initialRawInput
      ? `rawInput: |\n${initialRawInput.split('\n').map(line => '  ' + line).join('\n')}`
      : 'rawInput: ""';

    const initialContent = `---
integrated: false
artifactType: note
${rawInputYaml}
---
# Riff - ${now.toLocaleDateString()} ${now.toLocaleTimeString()}

`;
    await writeTextFile(fullPath, initialContent);

    return filename;
  }

  // Get the rawInput, crystallizedOffset, and artifactType from a draft's frontmatter
  async getDraftRawInput(riffNotePath: string): Promise<{ rawInput: string; crystallizedOffset: number; artifactType: RiffArtifactType }> {
    if (!this.vaultPath) return { rawInput: '', crystallizedOffset: 0, artifactType: 'note' };

    try {
      const fullPath = await join(this.vaultPath, riffNotePath);
      if (!(await exists(fullPath))) return { rawInput: '', crystallizedOffset: 0, artifactType: 'note' };

      const content = await readTextFile(fullPath);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return { rawInput: '', crystallizedOffset: 0, artifactType: 'note' };

      const frontmatter = fmMatch[1];

      // Parse rawInput (handles YAML literal block scalar)
      let rawInput = '';
      const rawInputMatch = frontmatter.match(/rawInput:\s*\|?\n?([\s\S]*?)(?=\n\w+:|$)/);
      if (rawInputMatch) {
        const rawValue = rawInputMatch[1];
        if (rawValue.startsWith('  ')) {
          rawInput = rawValue.split('\n').map(line => line.slice(2)).join('\n').trim();
        } else {
          rawInput = rawValue.replace(/^["']|["']$/g, '').trim();
        }
      }

      // Parse crystallizedOffset
      let crystallizedOffset = 0; // Default to nothing crystallized (allow editing)
      const offsetMatch = frontmatter.match(/crystallizedOffset:\s*(\d+)/);
      if (offsetMatch) {
        crystallizedOffset = parseInt(offsetMatch[1], 10);
      }

      // Parse artifactType
      let artifactType: RiffArtifactType = 'note';
      const typeMatch = frontmatter.match(/artifactType:\s*(\w+)/);
      if (typeMatch && (typeMatch[1] === 'note' || typeMatch[1] === 'mermaid')) {
        artifactType = typeMatch[1] as RiffArtifactType;
      }

      return { rawInput, crystallizedOffset, artifactType };
    } catch (error) {
      console.error('[RiffService] Failed to get draft rawInput:', error);
      return { rawInput: '', crystallizedOffset: 0, artifactType: 'note' };
    }
  }

  // Update the rawInput, crystallizedOffset, and optionally artifactType in a draft's frontmatter
  async updateDraftRawInput(riffNotePath: string, rawInput: string, crystallizedOffset?: number, artifactType?: RiffArtifactType): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const fullPath = await join(this.vaultPath, riffNotePath);
    if (!(await exists(fullPath))) return;

    const content = await readTextFile(fullPath);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return;

    const [, frontmatter, body] = fmMatch;

    // Build new frontmatter with updated rawInput and crystallizedOffset
    const rawInputYaml = rawInput
      ? `rawInput: |\n${rawInput.split('\n').map(line => '  ' + line).join('\n')}`
      : 'rawInput: ""';
    const offsetYaml = `crystallizedOffset: ${crystallizedOffset ?? rawInput.length}`;

    // Replace or add rawInput in frontmatter
    let newFrontmatter: string;
    if (frontmatter.includes('rawInput:')) {
      newFrontmatter = frontmatter.replace(/rawInput:[\s\S]*?(?=\n\w+:|$)/, rawInputYaml);
    } else {
      newFrontmatter = frontmatter.trim() + '\n' + rawInputYaml;
    }

    // Replace or add crystallizedOffset
    if (newFrontmatter.includes('crystallizedOffset:')) {
      newFrontmatter = newFrontmatter.replace(/crystallizedOffset:\s*\d+/, offsetYaml);
    } else {
      newFrontmatter = newFrontmatter.trim() + '\n' + offsetYaml;
    }

    // Replace or add artifactType
    if (artifactType) {
      if (newFrontmatter.includes('artifactType:')) {
        newFrontmatter = newFrontmatter.replace(/artifactType:\s*\w+/, `artifactType: ${artifactType}`);
      } else {
        newFrontmatter = newFrontmatter.trim() + `\nartifactType: ${artifactType}`;
      }
    }

    await writeTextFile(fullPath, `---\n${newFrontmatter}\n---\n${body}`);
  }

  // Update draft content directly (preserves frontmatter)
  async updateDraft(riffNotePath: string, content: string): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const fullPath = await join(this.vaultPath, riffNotePath);

    // Preserve frontmatter if it exists
    let frontmatter = '---\nintegrated: false\n---\n';
    if (await exists(fullPath)) {
      const existingContent = await readTextFile(fullPath);
      const fmMatch = existingContent.match(/^---\n[\s\S]*?\n---\n/);
      if (fmMatch) {
        frontmatter = fmMatch[0];
      }
    }

    await writeTextFile(fullPath, frontmatter + content);
  }

  // Mark a riff note as integrated
  async markRiffIntegrated(riffNotePath: string): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const fullPath = await join(this.vaultPath, riffNotePath);
    const content = await readTextFile(fullPath);

    // Update frontmatter
    const updatedContent = content.replace(
      /^---\nintegrated: false\n---/,
      '---\nintegrated: true\n---'
    );

    await writeTextFile(fullPath, updatedContent);
  }

  // Build the system prompt for crystallization based on artifact type
  private buildCrystallizePrompt(
    artifactType: RiffArtifactType,
    existingContent: string,
    newIncrementalText: string,
    headerDate: string,
    notesList: string
  ): string {
    if (artifactType === 'mermaid') {
      return `You are a visual thinking partner helping the user develop their ideas as a Mermaid diagram. You receive only the NEW text since the last update.

EXISTING DIAGRAM:
${existingContent || '(empty - start fresh)'}

NEW RAW INPUT to incorporate:
${newIncrementalText}

YOUR ROLE:
1. **Visualize their thoughts** as a Mermaid diagram (flowchart, mindmap, sequence diagram, etc.)
2. **Choose the best diagram type** based on the content (flowchart for processes, mindmap for brainstorming, sequence for interactions, etc.)
3. **Answer questions** they ask mid-riff by incorporating the answer into the diagram
4. **Fill in gaps** when they express uncertainty

RULES:
- Output ONLY a valid Mermaid diagram inside a \`\`\`mermaid code fence
- The entire output must be the fenced mermaid code block - nothing else before or after
- If there's an existing diagram, update it with the new thoughts woven in
- Keep the diagram readable - don't overcrowd nodes
- Use clear, concise labels on nodes and edges
- Preserve all existing nodes/relationships and add new ones as needed`;
    }

    // Default: note type (existing behavior)
    return `You are a thinking partner helping the user develop their thoughts. You receive only the NEW text since the last crystallization.

EXISTING NOTE:
${existingContent || `# Riff - ${headerDate}\n\n(empty - start fresh)`}

NEW RAW INPUT to incorporate:
${newIncrementalText}

YOUR ROLE:
1. **Organize their thoughts** into the note structure
2. **Answer questions** they ask mid-riff (e.g., "what was that film with...?" → provide the answer inline)
3. **Fill in gaps** when they express uncertainty ("I can't remember...", "what was that...", "something like...")
4. **Occasionally prompt** with a brief question to deepen their thinking (sparingly - don't overdo it)

FORMAT FOR YOUR CONTRIBUTIONS:
- Mark your contributions with *italics* so they're visually distinct from the user's thoughts
- Keep your contributions brief (1-2 sentences max)
- Don't summarize or rephrase what they said - add value, don't echo

RULES:
- Output the COMPLETE updated note (existing content + new thoughts woven in)
- Preserve the existing structure and all existing content
- Add new thoughts in appropriate sections or create new sections as needed
- Be concise but preserve the essence of all ideas
- Output ONLY the note content (no meta-commentary)

WIKILINK FORMAT:
- Use ONLY double-bracket syntax: [[Note Name]]

Existing notes in vault: ${notesList}`;
  }

  // Detect the best artifact type for the given input text
  async detectArtifactType(text: string, model: string): Promise<RiffArtifactType> {
    try {
      const providerType = getProviderFromModel(model);
      const modelId = getModelIdFromModel(model);
      const provider = providerRegistry.getProvider(providerType);

      if (!provider || !provider.isInitialized()) return 'note';

      const systemPrompt = `Classify the user's input into one of these artifact types. Respond with ONLY the type name, nothing else.

Types:
- note: General thoughts, writing, brainstorming, questions, notes
- mermaid: Relationships between things, processes, flows, hierarchies, comparisons, system architecture, sequences of events

Default to "note" unless the input clearly describes visual relationships, processes, or structures that would benefit from a diagram.`;

      const messages: Message[] = [
        { role: 'user', timestamp: new Date().toISOString(), content: text }
      ];

      let response = '';
      await provider.sendMessage(messages, {
        model: modelId,
        onChunk: (chunk: string) => { response += chunk; },
        systemPrompt,
      });

      const trimmed = response.trim().toLowerCase();
      if (trimmed === 'mermaid') return 'mermaid';
      return 'note';
    } catch (error) {
      console.error('[RiffService] Failed to detect artifact type:', error);
      return 'note';
    }
  }

  // Crystallize: incrementally extend the note with new thoughts
  // Only processes new text since last crystallization, using existing note as context
  async crystallize(
    newIncrementalText: string,  // Only the new text since last crystallize
    riffNotePath: string,
    existingNotes: NoteInfo[],
    model: string,
    signal?: AbortSignal,
    artifactType: RiffArtifactType = 'note'
  ): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const providerType = getProviderFromModel(model);
    const modelId = getModelIdFromModel(model);
    const provider = providerRegistry.getProvider(providerType);

    if (!provider || !provider.isInitialized()) {
      throw new Error(`Provider ${providerType} not initialized`);
    }

    const fullPath = await join(this.vaultPath, riffNotePath);

    // Build notes list for wikilink suggestions
    const notesList = existingNotes
      .filter(n => !n.filename.startsWith('riffs/'))
      .map(n => n.filename.replace('.md', ''))
      .join(', ');

    // Read existing crystallized content for context
    let existingContent = '';
    let frontmatter = '---\nintegrated: false\n---\n';
    if (await exists(fullPath)) {
      const fileContent = await readTextFile(fullPath);
      const fmMatch = fileContent.match(/^---\n[\s\S]*?\n---\n/);
      if (fmMatch) {
        frontmatter = fmMatch[0];
        existingContent = fileContent.slice(fmMatch[0].length);
      }
    }

    // Get timestamp from filename for the header (only used if starting fresh)
    const filename = riffNotePath.split('/').pop()?.replace('.md', '') || '';
    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})-(\d{6})/);
    let headerDate = new Date().toLocaleString();
    if (dateMatch) {
      const [, date, time] = dateMatch;
      const timeFormatted = `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
      headerDate = `${date} ${timeFormatted}`;
    }

    const systemPrompt = this.buildCrystallizePrompt(
      artifactType, existingContent, newIncrementalText, headerDate, notesList
    );

    const messages: Message[] = [
      { role: 'user', timestamp: new Date().toISOString(), content: `Incorporate the new input into the ${artifactType === 'mermaid' ? 'diagram' : 'note'}.` }
    ];

    // Stream the response
    let crystallized = '';
    await provider.sendMessage(messages, {
      model: modelId,
      onChunk: (chunk: string) => {
        crystallized += chunk;
      },
      signal,
      systemPrompt,
    });

    // Write the updated note, preserving frontmatter
    if (crystallized.trim()) {
      await writeTextFile(fullPath, frontmatter + crystallized.trim() + '\n');
    }
  }

  // Generate integration proposals for other notes
  async generateIntegrationProposal(
    riffNotePath: string,
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

    // Read riff note content
    const fullPath = await join(this.vaultPath, riffNotePath);
    const riffContent = await readTextFile(fullPath);

    // Read content of existing notes for context
    const notesWithContent: { filename: string; content: string }[] = [];
    for (const note of existingNotes.slice(0, 10)) { // Limit to 10 notes for context
      if (note.filename.startsWith('riffs/')) continue;
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
    const riffFilename = riffNotePath.split('/').pop()?.replace('.md', '') || riffNotePath;

    const systemPrompt = `You are analyzing a riff note and proposing specific changes to integrate key insights into other notes.

Return ONLY a valid JSON array of proposed changes. Each object must have:
- "type": "append" | "update" | "create"
- "path": filename (e.g., "notes/topic.md" or "memory.md")
- "description": brief description of the change
- "newContent": the actual content to add (with Obsidian wikilinks and provenance marker)
- "reasoning": why this integration makes sense

Rules:
- Prefer appending to existing notes over creating new ones
- Add provenance marker at the end: &[[riffs/${riffFilename}]]
- Only propose meaningful integrations - don't force it
- If no good integrations exist, return an empty array []

WIKILINK FORMAT (MUST FOLLOW EXACTLY):
- Use ONLY double-bracket syntax: [[Note Name]]
- WRONG: [text](wikilink:Note) or [text](Note Name)
- RIGHT: [[Note Name]]

Return ONLY the JSON array, no other text.`;

    const messages: Message[] = [
      {
        role: 'user',
        timestamp: new Date().toISOString(),
        content: `Riff content:\n\n${riffContent}\n\nExisting notes:\n\n${notesContext}`
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
      console.error('[RiffService] Failed to parse integration proposals:', error);
      return [];
    }
  }

  // Apply approved changes to notes
  // Ensures provenance marker is added to all content
  async applyProposedChanges(
    changes: ProposedChange[],
    vaultPath: string,
    riffNotePath?: string
  ): Promise<void> {
    // Extract riff filename for provenance (e.g., "2026-02-02-143052" from "riffs/2026-02-02-143052.md")
    const riffFilename = riffNotePath
      ? riffNotePath.split('/').pop()?.replace('.md', '') || ''
      : '';
    const provenanceMarker = riffFilename ? ` &[[riffs/${riffFilename}]]` : '';

    for (const change of changes) {
      try {
        const notePath = change.path.startsWith('notes/') || change.path === 'memory.md'
          ? await join(vaultPath, change.path)
          : await join(vaultPath, 'notes', change.path);

        // Ensure provenance marker is present in content
        let contentWithProvenance = change.newContent;
        if (provenanceMarker && !contentWithProvenance.includes('&[[riffs/')) {
          // Add provenance at end of content
          contentWithProvenance = contentWithProvenance.trimEnd() + provenanceMarker;
        }

        if (change.type === 'create') {
          // Create new file
          await writeTextFile(notePath, contentWithProvenance);
        } else if (change.type === 'append') {
          // Append to existing file
          let existingContent = '';
          if (await exists(notePath)) {
            existingContent = await readTextFile(notePath);
          }
          const updatedContent = existingContent.trimEnd() + '\n\n' + contentWithProvenance;
          await writeTextFile(notePath, updatedContent);
        } else if (change.type === 'update') {
          // Replace entire file content
          await writeTextFile(notePath, contentWithProvenance);
        }
      } catch (error) {
        console.error(`[RiffService] Failed to apply change to ${change.path}:`, error);
      }
    }

    // Mark the riff as integrated
    if (riffNotePath) {
      try {
        await this.markRiffIntegrated(riffNotePath);
      } catch (error) {
        console.error('[RiffService] Failed to mark riff as integrated:', error);
      }
    }
  }
}

export const riffService = new RiffService();
