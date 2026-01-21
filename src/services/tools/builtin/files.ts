import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';
import { ToolRegistry } from '../registry';
import { readTextFile, writeTextFile, exists, readDir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

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

export async function executeFileTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const vaultPath = vaultService.getVaultPath();
  console.log('[FileTools] vaultPath:', vaultPath);
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
      return await writeFile(fullPath, path, input.content as string);
    case 'append_file':
      return await appendFile(fullPath, path, input.content as string);
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
  content: string
): Promise<ToolResult> {
  if (content === undefined || content === null) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: content',
      is_error: true,
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

async function appendFile(
  fullPath: string,
  relativePath: string,
  content: string
): Promise<ToolResult> {
  if (content === undefined || content === null) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: content',
      is_error: true,
    };
  }

  try {
    let existingContent = '';
    if (await exists(fullPath)) {
      existingContent = await readTextFile(fullPath);
    }

    await writeTextFile(fullPath, existingContent + content);
    return {
      tool_use_id: '',
      content: `Successfully appended to ${relativePath}`,
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Error appending to file: ${error instanceof Error ? error.message : String(error)}`,
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
