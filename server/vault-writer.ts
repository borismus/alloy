/**
 * Server-side vault writer.
 *
 * Reads/writes conversation YAML files in the same format as the client's
 * VaultService, so the client's file watcher picks up changes seamlessly.
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type { StreamResult, ServerMessage } from './providers.js';

interface Conversation {
  id: string;
  title?: string;
  model: string;
  created: string;
  updated: string;
  messages: ConversationMessage[];
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'log';
  timestamp: string;
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
    responseId?: string;
  };
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFilename(id: string, title?: string): string {
  if (title) {
    const slug = generateSlug(title);
    return slug ? `${id}-${slug}.yaml` : `${id}.yaml`;
  }
  return `${id}.yaml`;
}

/**
 * Find a conversation file by its core ID (handles slug suffixes).
 */
async function findConversationFile(vaultPath: string, id: string): Promise<string | null> {
  const conversationsDir = path.join(vaultPath, 'conversations');
  try {
    const entries = await fs.readdir(conversationsDir);
    for (const entry of entries) {
      if (entry.endsWith('.yaml') && (entry === `${id}.yaml` || entry.startsWith(`${id}-`))) {
        return path.join(conversationsDir, entry);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return null;
}

/**
 * Append an assistant message to a conversation in the vault.
 * Reads the existing file, adds the message, writes it back.
 */
export async function appendAssistantMessage(
  vaultPath: string,
  conversationId: string,
  assistantMessageId: string,
  result: StreamResult,
  usage?: { inputTokens: number; outputTokens: number; cost?: number; responseId?: string },
): Promise<void> {
  const filePath = await findConversationFile(vaultPath, conversationId);
  if (!filePath) {
    console.error(`[VaultWriter] Conversation file not found for ID: ${conversationId}`);
    return;
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const conversation = yaml.load(content) as Conversation;

    const assistantMessage: ConversationMessage = {
      id: assistantMessageId,
      role: 'assistant',
      timestamp: new Date().toISOString(),
      content: result.content,
      ...(usage && { usage }),
    };

    conversation.messages.push(assistantMessage);
    conversation.updated = new Date().toISOString();

    // Write YAML
    await fs.writeFile(filePath, yaml.dump(conversation), 'utf-8');

    // Write markdown preview
    await writeMarkdownPreview(vaultPath, conversation, filePath);

    console.log(`[VaultWriter] Saved assistant message to ${path.basename(filePath)}`);
  } catch (e) {
    console.error('[VaultWriter] Failed to append message:', e);
  }
}

/**
 * Update the conversation title and rename the file if needed.
 */
export async function updateTitle(
  vaultPath: string,
  conversationId: string,
  newTitle: string,
): Promise<void> {
  const filePath = await findConversationFile(vaultPath, conversationId);
  if (!filePath) return;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const conversation = yaml.load(content) as Conversation;

    conversation.title = newTitle;
    conversation.updated = new Date().toISOString();

    const newFilename = generateFilename(conversationId, newTitle);
    const conversationsDir = path.dirname(filePath);
    const newFilePath = path.join(conversationsDir, newFilename);

    // Write to new path
    await fs.writeFile(newFilePath, yaml.dump(conversation), 'utf-8');

    // Remove old file if name changed
    if (newFilePath !== filePath) {
      await fs.rm(filePath, { force: true });
      // Also remove old markdown preview
      const oldMdPath = filePath.replace(/\.yaml$/, '.md');
      await fs.rm(oldMdPath, { force: true }).catch(() => {});
    }

    // Write markdown preview
    await writeMarkdownPreview(vaultPath, conversation, newFilePath);

    console.log(`[VaultWriter] Updated title to "${newTitle}"`);
  } catch (e) {
    console.error('[VaultWriter] Failed to update title:', e);
  }
}

async function writeMarkdownPreview(
  vaultPath: string,
  conversation: Conversation,
  yamlPath: string,
): Promise<void> {
  const mdPath = yamlPath.replace(/\.yaml$/, '.md');

  const frontmatter = yaml.dump({
    id: conversation.id,
    created: conversation.created,
    updated: conversation.updated,
    model: conversation.model,
    title: conversation.title,
  });

  const assistantName = conversation.model;
  const messages = conversation.messages
    .filter(m => m.role !== 'log')
    .map(m => {
      const role = m.role === 'user' ? 'You' : assistantName;
      return `### ${role}\n\n${m.content}`;
    })
    .join('\n\n---\n\n');

  const md = `---\n${frontmatter}---\n\n${messages}\n`;
  await fs.writeFile(mdPath, md, 'utf-8');
}
