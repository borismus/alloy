import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import * as yaml from 'js-yaml';
import { TriggerLogEntry } from '../../types';

interface TriggerLogsFile {
  entries: TriggerLogEntry[];
}

const MAX_LOG_ENTRIES = 1000;

export class TriggerLogService {
  private vaultPath: string | null = null;

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  private async getLogsPath(): Promise<string> {
    if (!this.vaultPath) {
      throw new Error('Vault path not set');
    }
    return join(this.vaultPath, 'triggers', 'logs.yaml');
  }

  private async getTriggersDir(): Promise<string> {
    if (!this.vaultPath) {
      throw new Error('Vault path not set');
    }
    return join(this.vaultPath, 'triggers');
  }

  async initializeTriggersDir(): Promise<void> {
    const triggersDir = await this.getTriggersDir();
    if (!(await exists(triggersDir))) {
      await mkdir(triggersDir, { recursive: true });
    }
  }

  async loadLogs(): Promise<TriggerLogEntry[]> {
    try {
      const logsPath = await this.getLogsPath();
      if (!(await exists(logsPath))) {
        return [];
      }

      const content = await readTextFile(logsPath);
      const data = yaml.load(content) as TriggerLogsFile | null;
      return data?.entries || [];
    } catch (error) {
      console.error('Failed to load trigger logs:', error);
      return [];
    }
  }

  async saveLogs(entries: TriggerLogEntry[]): Promise<void> {
    await this.initializeTriggersDir();
    const logsPath = await this.getLogsPath();
    const data: TriggerLogsFile = { entries };
    const content = yaml.dump(data, { lineWidth: -1 });
    await writeTextFile(logsPath, content);
  }

  async appendLog(entry: TriggerLogEntry): Promise<void> {
    const entries = await this.loadLogs();
    entries.unshift(entry); // Add to beginning (most recent first)

    // Prune if exceeds max
    const prunedEntries = entries.slice(0, MAX_LOG_ENTRIES);
    await this.saveLogs(prunedEntries);
  }

  async getLogsForConversation(conversationId: string): Promise<TriggerLogEntry[]> {
    const entries = await this.loadLogs();
    return entries.filter(e => e.conversationId === conversationId);
  }

  async pruneLogs(maxEntries: number = MAX_LOG_ENTRIES): Promise<void> {
    const entries = await this.loadLogs();
    if (entries.length > maxEntries) {
      await this.saveLogs(entries.slice(0, maxEntries));
    }
  }
}

export const triggerLogService = new TriggerLogService();
