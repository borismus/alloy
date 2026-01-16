import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';
import { ToolRegistry } from '../registry';
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

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

  const fullPath = await join(vaultPath, path);

  switch (toolName) {
    case 'read_file':
      return await readFile(fullPath, path);
    case 'write_file':
      return await writeFile(fullPath, path, input.content as string);
    case 'append_file':
      return await appendFile(fullPath, path, input.content as string);
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
