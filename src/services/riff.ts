import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Message, NoteInfo, ProposedChange, RiffArtifactType, RiffMessage, RiffComment, getProviderFromModel, getModelIdFromModel } from '../types';
import { providerRegistry } from './providers';
import { getOrchestratorModel } from './background';

interface RiffHistoryFile {
  messages: Message[];
}

const MAX_MESSAGES = 50;
const RIFF_FILENAME = 'riff_history.yaml';

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
  async getOrCreateRiffNote(): Promise<string> {
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

    const initialContent = `---
integrated: false
artifactType: note
history: []
messages: []
---
# Riff - ${now.toLocaleDateString()} ${now.toLocaleTimeString()}

`;
    await writeTextFile(fullPath, initialContent);

    return filename;
  }

  // Get messages, artifactType, and comments from a draft's frontmatter
  async getDraftMessages(riffNotePath: string): Promise<{ messages: RiffMessage[]; artifactType: RiffArtifactType; comments: RiffComment[] }> {
    if (!this.vaultPath) return { messages: [], artifactType: 'note', comments: [] };

    try {
      const fullPath = await join(this.vaultPath, riffNotePath);
      if (!(await exists(fullPath))) return { messages: [], artifactType: 'note', comments: [] };

      const content = await readTextFile(fullPath);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return { messages: [], artifactType: 'note', comments: [] };

      const fmBody = fmMatch[1];
      const parsed = yaml.load(fmBody) as Record<string, any> || {};

      // Parse artifactType
      let artifactType: RiffArtifactType = 'note';
      if (parsed.artifactType === 'mermaid' || parsed.artifactType === 'table' || parsed.artifactType === 'note' || parsed.artifactType === 'summary') {
        artifactType = parsed.artifactType;
      }

      // Parse comments
      const comments: RiffComment[] = Array.isArray(parsed.comments)
        ? parsed.comments.map((c: any) => ({
            id: c.id || `comment-${Date.now()}`,
            timestamp: c.timestamp || '',
            anchor: {
              paragraphIndex: c.anchor?.paragraphIndex ?? 0,
              snippet: c.anchor?.snippet || '',
            },
            content: c.content || '',
          }))
        : [];

      // Parse messages (new format)
      if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        const messages: RiffMessage[] = parsed.messages.map((m: any) => ({
          role: 'user' as const,
          timestamp: m.timestamp || '',
          content: m.content || '',
          ...(m.action && { action: m.action }),
        }));
        return { messages, artifactType, comments };
      }

      // Backward compat: migrate from old rawInput format
      if (parsed.rawInput && typeof parsed.rawInput === 'string' && parsed.rawInput.trim()) {
        const messages: RiffMessage[] = [{
          role: 'user',
          timestamp: new Date().toISOString(),
          content: parsed.rawInput.trim(),
        }];
        return { messages, artifactType, comments };
      }

      return { messages: [], artifactType, comments };
    } catch (error) {
      console.error('[RiffService] Failed to get draft messages:', error);
      return { messages: [], artifactType: 'note', comments: [] };
    }
  }

  // Update messages and optionally artifactType in a draft's frontmatter
  async updateDraftMessages(riffNotePath: string, messages: RiffMessage[], artifactType?: RiffArtifactType): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const fullPath = await join(this.vaultPath, riffNotePath);
    if (!(await exists(fullPath))) return;

    const content = await readTextFile(fullPath);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return;

    const [, fmBody, body] = fmMatch;
    const parsed = yaml.load(fmBody) as Record<string, any> || {};

    // Update messages (cap at MAX_MESSAGES)
    parsed.messages = messages.slice(-MAX_MESSAGES).map(m => ({
      role: m.role,
      timestamp: m.timestamp,
      content: m.content,
      ...(m.action && { action: m.action }),
    }));

    // Update artifactType if provided
    if (artifactType) {
      parsed.artifactType = artifactType;
    }

    // Remove old fields if present
    delete parsed.rawInput;
    delete parsed.crystallizedOffset;

    await writeTextFile(fullPath, `---\n${yaml.dump(parsed, { lineWidth: -1 })}---\n${body}`);
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

  // Build the system prompt for artifact update based on type
  private buildUpdatePrompt(
    artifactType: RiffArtifactType,
    existingContent: string,
    messageHistory: RiffMessage[],
    latestMessage: string,
    headerDate: string,
    notesList: string
  ): string {
    // Format conversation history (all messages except the latest)
    const historyLines = messageHistory.slice(0, -1).map((m, i) =>
      `[${i + 1}] ${m.content}`
    ).join('\n');
    const historySection = historyLines
      ? `\nCONVERSATION HISTORY:\n${historyLines}\n`
      : '';

    if (artifactType === 'mermaid') {
      return `You are a visual thinking partner helping the user develop their ideas as a Mermaid diagram.

EXISTING DIAGRAM:
${existingContent || '(empty - start fresh)'}
${historySection}
LATEST MESSAGE:
${latestMessage}

YOUR ROLE:
1. **Visualize their thoughts** as a Mermaid diagram (flowchart, mindmap, sequence diagram, etc.)
2. **Choose the best diagram type** based on the content (flowchart for processes, mindmap for brainstorming, sequence for interactions, etc.)
3. **Answer questions** by incorporating the answer into the diagram
4. **Fill in gaps** when they express uncertainty
5. **Follow instructions** — if they ask to change, add, or remove something, do it

RULES:
- Output ONLY a valid Mermaid diagram inside a \`\`\`mermaid code fence
- The entire output must be the fenced mermaid code block - nothing else before or after
- If there's an existing diagram, update it based on the latest message
- Keep the diagram readable - don't overcrowd nodes
- Use clear, concise labels on nodes and edges
- Preserve existing nodes/relationships unless the user asks to change them

CHANGE LOG:
Before your main output, include a single <changes> tag with a brief description of what you changed and why:
<changes>Your change description here</changes>`;
    }

    if (artifactType === 'summary') {
      return `You are a concise summarizer helping the user distill their thoughts.

EXISTING SUMMARY:
${existingContent || '(empty - start fresh)'}
${historySection}
LATEST MESSAGE:
${latestMessage}

YOUR ROLE:
1. **Distill** all messages and existing content into a clear, concise summary
2. **Organize** by theme or topic, not chronologically
3. **Highlight** key decisions, insights, and open questions
4. **Follow instructions** — if they ask to adjust focus, expand, or trim, do it

RULES:
- Output a well-structured Markdown summary (use headings, bullets, bold for emphasis)
- Be concise — aim for ~30% of the original content length
- Preserve key facts and decisions, drop filler and repetition
- Output ONLY the summary content (no meta-commentary)

CHANGE LOG:
Before your main output, include a single <changes> tag with a brief description of what you changed and why:
<changes>Your change description here</changes>`;
    }

    if (artifactType === 'table') {
      return `You are a structured thinking partner helping the user develop their ideas as a Markdown table.

EXISTING TABLE:
${existingContent || '(empty - start fresh)'}
${historySection}
LATEST MESSAGE:
${latestMessage}

YOUR ROLE:
1. **Structure their thoughts** into a well-organized Markdown table
2. **Choose appropriate columns** based on the content (comparisons, features, pros/cons, timelines, etc.)
3. **Answer questions** by incorporating the answer into the table
4. **Fill in gaps** when they express uncertainty
5. **Reorganize** columns or rows when the data calls for it
6. **Follow instructions** — if they ask to change, add, or remove something, do it

RULES:
- Output ONLY a valid Markdown table - nothing else before or after
- Use standard Markdown table syntax with | delimiters and header separators (---)
- If there's an existing table, update it based on the latest message
- Keep cells concise - use short phrases, not paragraphs
- Preserve existing rows/columns unless the user asks to change them
- Use alignment (left/center/right) when it improves readability

CHANGE LOG:
Before your main output, include a single <changes> tag with a brief description of what you changed and why:
<changes>Your change description here</changes>`;
    }

    // Default: note type
    return `You are a thinking partner helping the user develop their thoughts.

EXISTING NOTE:
${existingContent || `# Riff - ${headerDate}\n\n(empty - start fresh)`}
${historySection}
LATEST MESSAGE:
${latestMessage}

YOUR ROLE:
1. **Organize their thoughts** into the note structure
2. **Answer questions** they ask (e.g., "what was that film with...?" → provide the answer inline)
3. **Fill in gaps** when they express uncertainty ("I can't remember...", "what was that...", "something like...")
4. **Follow instructions** — if they ask to rephrase, restructure, or change something, do it
5. **Occasionally prompt** with a brief question to deepen their thinking (sparingly)

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

CHANGE LOG:
Before your main output, include a single <changes> tag with a brief description of what you changed and why:
<changes>Your change description here</changes>

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
- mermaid: Relationships between things, processes, flows, hierarchies, system architecture, sequences of events
- table: Comparisons, lists of items with attributes, pros/cons, feature matrices, rankings, structured data
- summary: Explicit requests to summarize, condense, or distill (e.g., "summarize this", "give me a summary", "condense everything")

Also detect mode-switch requests: "show this as a table", "turn this into a diagram", "make a mermaid chart", "summarize everything so far".

Default to "note" unless the input clearly matches another type.`;

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
      if (trimmed === 'table') return 'table';
      if (trimmed === 'summary') return 'summary';
      return 'note';
    } catch (error) {
      console.error('[RiffService] Failed to detect artifact type:', error);
      return 'note';
    }
  }

  // Update the artifact based on the user's latest message and conversation history
  async updateArtifact(
    latestMessage: string,
    messageHistory: RiffMessage[],
    riffNotePath: string,
    existingNotes: NoteInfo[],
    model: string,
    signal?: AbortSignal,
    artifactType: RiffArtifactType = 'note'
  ): Promise<{ changeDescription: string }> {
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

    // Read existing content for context
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

    const systemPrompt = this.buildUpdatePrompt(
      artifactType, existingContent, messageHistory, latestMessage, headerDate, notesList
    );

    const messages: Message[] = [
      { role: 'user', timestamp: new Date().toISOString(), content: `Update the ${artifactType === 'mermaid' ? 'diagram' : artifactType === 'table' ? 'table' : 'note'} based on the latest message.` }
    ];

    // Stream the response
    let response = '';
    await provider.sendMessage(messages, {
      model: modelId,
      onChunk: (chunk: string) => {
        response += chunk;
      },
      signal,
      systemPrompt,
    });

    // Extract <changes> tag from response (if present) and strip it from content
    let changeDescription = '';
    const changesMatch = response.match(/<changes>([\s\S]*?)<\/changes>/);
    if (changesMatch) {
      changeDescription = changesMatch[1].trim();
      response = response.replace(/<changes>[\s\S]*?<\/changes>\s*/, '');
    }

    // Write the updated artifact
    if (response.trim()) {
      // Re-read frontmatter to avoid clobbering concurrent updates
      let currentFrontmatter = frontmatter;
      if (await exists(fullPath)) {
        const currentContent = await readTextFile(fullPath);
        const fmMatch = currentContent.match(/^---\n[\s\S]*?\n---\n/);
        if (fmMatch) {
          currentFrontmatter = fmMatch[0];
        }
      }

      // Add history entry to frontmatter if we got a change description
      if (changeDescription) {
        const fmBody = currentFrontmatter.replace(/^---\n/, '').replace(/\n---\n$/, '');
        const parsed = yaml.load(fmBody) as Record<string, any> || {};
        const history: Array<{ timestamp: string; change: string }> = Array.isArray(parsed.history) ? parsed.history : [];
        history.push({ timestamp: new Date().toISOString(), change: changeDescription });
        // Cap at 50 entries
        if (history.length > MAX_MESSAGES) {
          history.splice(0, history.length - MAX_MESSAGES);
        }
        parsed.history = history;
        currentFrontmatter = `---\n${yaml.dump(parsed, { lineWidth: -1 })}---\n`;
      }

      await writeTextFile(fullPath, currentFrontmatter + response.trim() + '\n');
    }

    return { changeDescription };
  }

  // Classify user input as content to append or a command to modify the document
  async classifyInput(text: string): Promise<'append' | 'command'> {
    // Fast path: long text is almost always content to append
    if (text.split(/\s+/).length > 30) return 'append';

    try {
      const modelKey = getOrchestratorModel();
      if (!modelKey) return 'append';

      const providerType = getProviderFromModel(modelKey);
      const modelId = getModelIdFromModel(modelKey);
      const provider = providerRegistry.getProvider(providerType);

      if (!provider || !provider.isInitialized()) return 'append';

      const systemPrompt = `Classify the user's input. Is it:
- APPEND: Content to add to a document (thoughts, notes, ideas, paragraphs, sentences)
- COMMAND: An instruction to modify existing document content (edit, delete, rewrite, restructure, fix)

Reply with ONLY the word APPEND or COMMAND.`;

      const messages: Message[] = [
        { role: 'user', timestamp: new Date().toISOString(), content: text }
      ];

      let response = '';
      await provider.sendMessage(messages, {
        model: modelId,
        onChunk: (chunk: string) => { response += chunk; },
        systemPrompt,
      });

      return response.trim().toUpperCase().includes('COMMAND') ? 'command' : 'append';
    } catch (error) {
      console.error('[RiffService] Failed to classify input:', error);
      return 'append';
    }
  }

  // Append text directly to the document body, preserving frontmatter
  async appendToDocument(riffNotePath: string, text: string): Promise<void> {
    if (!this.vaultPath) throw new Error('Vault path not set');

    const fullPath = await join(this.vaultPath, riffNotePath);
    if (!(await exists(fullPath))) throw new Error('Draft file not found');

    const content = await readTextFile(fullPath);
    const fmMatch = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);

    if (fmMatch) {
      const [, frontmatter, body] = fmMatch;
      const separator = body.trim() ? '\n\n' : '';
      await writeTextFile(fullPath, frontmatter + body.trimEnd() + separator + text + '\n');
    } else {
      // No frontmatter — just append
      const separator = content.trim() ? '\n\n' : '';
      await writeTextFile(fullPath, content.trimEnd() + separator + text + '\n');
    }
  }

  // Apply a command/change to the document using AI
  async applyCommand(
    command: string,
    riffNotePath: string,
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

    const fullPath = await join(this.vaultPath, riffNotePath);
    if (!(await exists(fullPath))) throw new Error('Draft file not found');

    const content = await readTextFile(fullPath);
    const fmMatch = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
    const frontmatter = fmMatch ? fmMatch[1] : '';
    const body = fmMatch ? fmMatch[2] : content;

    const systemPrompt = `You are editing a document based on the user's instruction.

CURRENT DOCUMENT:
${body}

Output the COMPLETE updated document. Only change what the user requested. Preserve everything else exactly as-is. Output ONLY the document content, no commentary.`;

    const messages: Message[] = [
      { role: 'user', timestamp: new Date().toISOString(), content: command }
    ];

    let response = '';
    await provider.sendMessage(messages, {
      model: modelId,
      onChunk: (chunk: string) => { response += chunk; },
      signal,
      systemPrompt,
    });

    if (response.trim()) {
      // Re-read frontmatter to avoid clobbering concurrent updates
      let currentFrontmatter = frontmatter;
      if (await exists(fullPath)) {
        const currentContent = await readTextFile(fullPath);
        const fm = currentContent.match(/^(---\n[\s\S]*?\n---\n)/);
        if (fm) currentFrontmatter = fm[1];
      }
      await writeTextFile(fullPath, currentFrontmatter + response.trim() + '\n');
    }
  }

  // Generate AI comments on the document — acts as a conversational nudge
  async generateComments(
    riffNotePath: string,
    recentInput: string,
    existingNotes: NoteInfo[],
    model: string,
    signal?: AbortSignal,
    messagesSinceLastComment: number = 0,
    existingCommentParagraphs: number[] = []
  ): Promise<RiffComment[]> {
    if (!this.vaultPath) return [];

    try {
      const providerType = getProviderFromModel(model);
      const modelId = getModelIdFromModel(model);
      const provider = providerRegistry.getProvider(providerType);

      if (!provider || !provider.isInitialized()) return [];

      const fullPath = await join(this.vaultPath, riffNotePath);
      if (!(await exists(fullPath))) return [];

      const content = await readTextFile(fullPath);
      const fmMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = fmMatch ? fmMatch[1] : content;

      if (!body.trim()) return [];

      // Split body into paragraphs for reference
      const allParagraphs = body.split(/\n\n+/).filter(p => p.trim());

      const notesList = existingNotes
        .filter(n => !n.filename.startsWith('riffs/'))
        .map(n => n.filename.replace('.md', ''))
        .join(', ');

      // Send last N paragraphs for context, allow comments on last K
      const CONTEXT_WINDOW = 10;
      const COMMENT_WINDOW = 3;
      const contextStart = Math.max(0, allParagraphs.length - CONTEXT_WINDOW);
      const commentStart = Math.max(0, allParagraphs.length - COMMENT_WINDOW);
      const contextParagraphs = allParagraphs.slice(contextStart);

      const commentRange = allParagraphs.length > 0
        ? `[${commentStart}] through [${allParagraphs.length - 1}]`
        : 'none';

      // Lower the bar progressively when we haven't commented in a while
      const eagernessGuidance = messagesSinceLastComment >= 5
        ? `It's been a while since you commented. If something interesting has come up, now would be a good time.`
        : messagesSinceLastComment >= 3
        ? `Feel free to comment if something genuinely stands out — a contradiction, an unexplored angle, or a connection to an existing note.`
        : `Only comment if something is genuinely surprising, contradictory, or connects to an existing vault note. When in doubt, return an empty array.`;

      const existingNote = existingCommentParagraphs.length > 0
        ? `\nParagraphs that ALREADY have comments: [${existingCommentParagraphs.join(', ')}]. Do NOT comment on these again.`
        : '';

      const systemPrompt = `You are a curious, engaged thinking partner in a live note-taking session. The user is speaking or typing their thoughts and you can leave short margin comments.

RECENT TRANSCRIPT (paragraphs numbered for reference):
${contextParagraphs.map((p, i) => `[${contextStart + i}] ${p}`).join('\n\n')}

WHAT THE USER JUST ADDED:
${recentInput}

EXISTING NOTES IN VAULT:
${notesList || '(none)'}

SCOPE: Only comment on paragraphs ${commentRange}.${existingNote}

DENSITY RULES:
- Return AT MOST 1 comment total.
- Never comment on a paragraph that already has a comment.
- Avoid commenting on a paragraph immediately adjacent to one that has a comment.

EAGERNESS: ${eagernessGuidance}

Good comments include:
- A short question that prompts the user to say more ("What made you choose X over Y?", "How did that turn out?")
- A connection to an existing vault note (use [[Note Name]] syntax)
- A brief reaction or observation ("This contradicts what you said earlier about...", "Interesting — this reminds me of...")
- Flagging something worth exploring ("You mentioned X but didn't elaborate — worth expanding?")

Keep comments to 1-2 sentences max. Be conversational, not formal. Think of yourself as a smart friend listening and occasionally chiming in.

Return a JSON array with 0 or 1 items. Each item: {"paragraphIndex": <number>, "snippet": "<first 50 chars of that paragraph>", "content": "<your comment>"}

Return an empty array [] if nothing compelling stands out or all eligible paragraphs already have comments.

Return ONLY the JSON array, no other text.`;

      const messages: Message[] = [
        { role: 'user', timestamp: new Date().toISOString(), content: 'Review the document.' }
      ];

      let response = '';
      await provider.sendMessage(messages, {
        model: modelId,
        onChunk: (chunk: string) => { response += chunk; },
        signal,
        systemPrompt,
      });

      // Parse JSON response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        paragraphIndex: number;
        snippet: string;
        content: string;
      }>;

      // Enforce density: only recent window, skip already-commented and adjacent
      const commentedSet = new Set(existingCommentParagraphs);
      const filtered = parsed
        .filter(c => c.paragraphIndex >= commentStart)
        .filter(c => !commentedSet.has(c.paragraphIndex))
        .filter(c => !commentedSet.has(c.paragraphIndex - 1) && !commentedSet.has(c.paragraphIndex + 1))
        .slice(0, 1); // At most 1 new comment

      const now = new Date().toISOString();
      return filtered.map((c, i) => ({
        id: `comment-${Date.now()}-${i}`,
        timestamp: now,
        anchor: {
          paragraphIndex: c.paragraphIndex,
          snippet: c.snippet || '',
        },
        content: c.content,
      }));
    } catch (error) {
      console.error('[RiffService] Failed to generate comments:', error);
      return [];
    }
  }

  // Persist comments to frontmatter
  async updateDraftComments(riffNotePath: string, comments: RiffComment[]): Promise<void> {
    if (!this.vaultPath) return;

    const fullPath = await join(this.vaultPath, riffNotePath);
    if (!(await exists(fullPath))) return;

    const content = await readTextFile(fullPath);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return;

    const [, fmBody, body] = fmMatch;
    const parsed = yaml.load(fmBody) as Record<string, any> || {};

    parsed.comments = comments.map(c => ({
      id: c.id,
      timestamp: c.timestamp,
      anchor: { paragraphIndex: c.anchor.paragraphIndex, snippet: c.anchor.snippet },
      content: c.content,
    }));

    await writeTextFile(fullPath, `---\n${yaml.dump(parsed, { lineWidth: -1 })}---\n${body}`);
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
