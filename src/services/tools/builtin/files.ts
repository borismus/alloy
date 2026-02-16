import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';
import { ToolRegistry } from '../registry';
import { readTextFile, writeTextFile, exists, readDir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import yaml from 'js-yaml';

// Directory permission configuration
// Defines which directories the AI can read from and write to
interface DirectoryPermission {
  path: string;
  read: boolean;
  write: boolean;
}

const DIRECTORY_PERMISSIONS: DirectoryPermission[] = [
  { path: 'notes/', read: true, write: true },
  { path: 'skills/', read: true, write: true },
  { path: 'conversations/', read: true, write: false },
  { path: 'triggers/', read: true, write: true },
];

/**
 * Check if a path is allowed for the given operation.
 * - Root-level files (e.g., memory.md) are always allowed
 * - Directories must be explicitly listed in DIRECTORY_PERMISSIONS
 * - Unlisted directories are denied by default
 */
function checkPathPermission(relativePath: string, operation: 'read' | 'write'): boolean {
  const normalized = relativePath.replace(/\\/g, '/');

  // Check against configured directory permissions
  for (const perm of DIRECTORY_PERMISSIONS) {
    if (normalized.startsWith(perm.path) || normalized === perm.path.slice(0, -1)) {
      return operation === 'read' ? perm.read : perm.write;
    }
  }

  // Allow root-level files (no directory in path)
  if (!normalized.includes('/')) {
    return true;
  }

  // Deny by default for unlisted directories
  return false;
}

/**
 * Validate trigger YAML content before writing to triggers/ directory.
 * Returns null if valid, or an error message if invalid.
 */
function validateTriggerYaml(content: string): string | null {
  // Parse YAML
  let data: unknown;
  try {
    data = yaml.load(content);
  } catch (e) {
    return `Invalid YAML syntax: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!data || typeof data !== 'object') {
    return 'Trigger file must be a YAML object';
  }

  const trigger = data as Record<string, unknown>;

  // Check required top-level fields
  if (!trigger.id || typeof trigger.id !== 'string') {
    return 'Missing or invalid field: id (must be a string)';
  }
  if (!trigger.title || typeof trigger.title !== 'string') {
    return 'Missing or invalid field: title (must be a string)';
  }
  if (!trigger.model || typeof trigger.model !== 'string') {
    return 'Missing or invalid field: model (must be a string)';
  }
  if (!trigger.model.includes('/')) {
    return 'Invalid model format: must be "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929")';
  }

  // Check trigger config fields (now flat, at top level)
  if (typeof trigger.enabled !== 'boolean') {
    return 'Missing or invalid field: enabled (must be a boolean)';
  }
  if (!trigger.triggerPrompt || typeof trigger.triggerPrompt !== 'string') {
    return 'Missing or invalid field: triggerPrompt (must be a non-empty string)';
  }
  if (typeof trigger.intervalMinutes !== 'number' || (trigger.intervalMinutes as number) < 1) {
    return 'Missing or invalid field: intervalMinutes (must be a positive number)';
  }

  // Check messages array exists (can be empty)
  if (!Array.isArray(trigger.messages)) {
    return 'Missing or invalid field: messages (must be an array)';
  }

  return null; // Valid
}

export async function executeFileTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const vaultPath = vaultService.getVaultPath();
  if (!vaultPath) {
    return {
      tool_use_id: '',
      content: 'No vault path configured. Ensure vault is loaded before using file tools.',
      is_error: true,
    };
  }

  const path = input.path as string;
  if (!path) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: path',
      is_error: true,
    };
  }

  // Validate path doesn't escape vault
  if (!ToolRegistry.validatePath(path)) {
    return {
      tool_use_id: '',
      content: 'Invalid path: must be relative and cannot contain ".."',
      is_error: true,
    };
  }

  // Check directory permissions
  const requiredPermission = toolName === 'read_file' ? 'read' : 'write';
  if (!checkPathPermission(path, requiredPermission)) {
    return {
      tool_use_id: '',
      content: `Access denied: ${requiredPermission} permission not allowed for path "${path}"`,
      is_error: true,
    };
  }

  const fullPath = await join(vaultPath, path);

  switch (toolName) {
    case 'read_file':
      return await readFile(fullPath, path);
    case 'write_file':
      return await writeFile(fullPath, path, input.content as string, input._requireApproval as boolean | undefined);
    case 'append_to_note':
      return await appendToNote(fullPath, path, input.content as string, input._messageId as string | undefined, input._conversationId as string | undefined);
    case 'list_directory':
      return await listDirectory(fullPath, path);
    default:
      return {
        tool_use_id: '',
        content: `Unknown file tool: ${toolName}`,
        is_error: true,
      };
  }
}

async function readFile(fullPath: string, relativePath: string): Promise<ToolResult> {
  try {
    if (!(await exists(fullPath))) {
      return {
        tool_use_id: '',
        content: `File not found: ${relativePath}`,
        is_error: true,
      };
    }

    const content = await readTextFile(fullPath);
    return {
      tool_use_id: '',
      content,
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}

async function writeFile(
  fullPath: string,
  relativePath: string,
  content: string,
  requireApproval?: boolean
): Promise<ToolResult> {
  if (content === undefined || content === null) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: content',
      is_error: true,
    };
  }

  // Validate trigger YAML when writing to triggers/ directory
  const normalizedPath = relativePath.replace(/\\/g, '/');
  if (normalizedPath.startsWith('triggers/') && normalizedPath.endsWith('.yaml') && !normalizedPath.endsWith('logs.yaml')) {
    const validationError = validateTriggerYaml(content);
    if (validationError) {
      return {
        tool_use_id: '',
        content: `Invalid trigger file: ${validationError}`,
        is_error: true,
      };
    }
  }

  // If approval is required, return the data for UI to show diff
  if (requireApproval) {
    let originalContent = '';
    try {
      if (await exists(fullPath)) {
        originalContent = await readTextFile(fullPath);
      }
    } catch {
      // File doesn't exist, that's fine
    }

    return {
      tool_use_id: '',
      content: `Approval required to write to ${relativePath}`,
      requires_approval: true,
      approval_data: {
        path: relativePath,
        originalContent,
        newContent: content,
      },
    };
  }

  try {
    await writeTextFile(fullPath, content);
    return {
      tool_use_id: '',
      content: `Successfully wrote to ${relativePath}`,
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}

async function appendToNote(
  fullPath: string,
  relativePath: string,
  content: string,
  messageId?: string,
  conversationId?: string
): Promise<ToolResult> {
  if (content === undefined || content === null) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: content',
      is_error: true,
    };
  }

  // Generate a fallback message ID if not provided
  const provId = messageId || `msg-${Math.random().toString(16).slice(2, 6)}`;
  // Use conversation ID from context, fallback to 'unknown' if not provided
  const convId = conversationId || 'unknown';

  // Add provenance marker to each non-empty line
  // Reference points to the source conversation (e.g., 'ramble_history' or 'conversations/...')
  const contentWithProvenance = content
    .split('\n')
    .map(line => line.trim() ? `${line} &[[${convId}^${provId}]]` : line)
    .join('\n');

  try {
    let existingContent = '';
    if (await exists(fullPath)) {
      existingContent = await readTextFile(fullPath);
    }

    // Ensure proper spacing between existing content and new content
    const newContent = existingContent
      ? existingContent.trimEnd() + '\n\n' + contentWithProvenance
      : contentWithProvenance;

    await writeTextFile(fullPath, newContent);
    return {
      tool_use_id: '',
      content: `Appended to ${relativePath}`,
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Error appending to note: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}

async function listDirectory(fullPath: string, relativePath: string): Promise<ToolResult> {
  try {
    if (!(await exists(fullPath))) {
      return {
        tool_use_id: '',
        content: `Directory not found: ${relativePath}`,
        is_error: true,
      };
    }

    const entries = await readDir(fullPath);
    const files = entries
      .filter(entry => entry.name && !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
      }))
      .sort((a, b) => {
        // Directories first, then alphabetically
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });

    return {
      tool_use_id: '',
      content: JSON.stringify({ directory: relativePath, files }, null, 2),
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}
