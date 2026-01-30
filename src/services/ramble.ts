import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { Message } from '../types';

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
}

export const rambleService = new RambleService();
