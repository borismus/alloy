import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';
import { ToolRegistry } from '../registry';
import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

// Configuration constants
const MAX_RESULTS = 50;
const DEFAULT_MAX_RESULTS = 20;
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_RECURSION_DEPTH = 3;
const MAX_FILES_TO_SEARCH = 500;
const SNIPPET_CONTEXT = 50;

// Directory permissions (must match files.ts)
interface DirectoryPermission {
  path: string;
  read: boolean;
}

const DIRECTORY_PERMISSIONS: DirectoryPermission[] = [
  { path: 'notes/', read: true },
  { path: 'skills/', read: true },
  { path: 'conversations/', read: true },
];

function checkSearchPermission(directory: string): boolean {
  const normalized = directory.replace(/\\/g, '/');
  const dirPath = normalized.endsWith('/') ? normalized : normalized + '/';

  for (const perm of DIRECTORY_PERMISSIONS) {
    if (dirPath === perm.path || dirPath.startsWith(perm.path)) {
      return perm.read;
    }
  }
  return false;
}

interface MatchInfo {
  line: number;
  snippet: string;
}

interface SearchResult {
  path: string;
  matches: MatchInfo[];
}

interface SearchResponse {
  results: SearchResult[];
  total_matches: number;
  searched_files: number;
}

interface SearchCounters {
  totalMatches: number;
  searchedFiles: number;
}

export async function executeSearchTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (toolName !== 'search_directory') {
    return {
      tool_use_id: '',
      content: `Unknown search tool: ${toolName}`,
      is_error: true,
    };
  }

  return await searchDirectory(input);
}

async function searchDirectory(input: Record<string, unknown>): Promise<ToolResult> {
  // Validate inputs
  const directory = input.directory as string;
  const query = input.query as string;
  const searchContent = (input.search_content as string) !== 'false';
  const maxResults = Math.min(
    parseInt(input.max_results as string) || DEFAULT_MAX_RESULTS,
    MAX_RESULTS
  );
  const fileExtension = input.file_extension as string | undefined;

  if (!directory) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: directory',
      is_error: true,
    };
  }

  if (!query) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: query',
      is_error: true,
    };
  }

  // Validate path security
  if (!ToolRegistry.validatePath(directory)) {
    return {
      tool_use_id: '',
      content: 'Invalid directory: must be relative and cannot contain ".."',
      is_error: true,
    };
  }

  // Check permissions
  if (!checkSearchPermission(directory)) {
    return {
      tool_use_id: '',
      content: `Access denied: search not allowed for directory "${directory}"`,
      is_error: true,
    };
  }

  const vaultPath = vaultService.getVaultPath();
  if (!vaultPath) {
    return {
      tool_use_id: '',
      content: 'No vault path configured',
      is_error: true,
    };
  }

  const searchPath = await join(vaultPath, directory);
  if (!(await exists(searchPath))) {
    return {
      tool_use_id: '',
      content: `Directory not found: ${directory}`,
      is_error: true,
    };
  }

  // Perform search
  const results: SearchResult[] = [];
  const counters: SearchCounters = { totalMatches: 0, searchedFiles: 0 };

  await searchRecursive(
    searchPath,
    directory,
    query.toLowerCase(),
    searchContent,
    fileExtension,
    results,
    counters,
    maxResults,
    0
  );

  // Build response
  const response: SearchResponse = {
    results: results.slice(0, maxResults),
    total_matches: counters.totalMatches,
    searched_files: counters.searchedFiles,
  };

  return {
    tool_use_id: '',
    content: JSON.stringify(response, null, 2),
  };
}

async function searchRecursive(
  fullPath: string,
  relativePath: string,
  query: string,
  searchContent: boolean,
  fileExtension: string | undefined,
  results: SearchResult[],
  counters: SearchCounters,
  maxResults: number,
  depth: number
): Promise<void> {
  if (depth > MAX_RECURSION_DEPTH) return;
  if (counters.searchedFiles >= MAX_FILES_TO_SEARCH) return;
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = await readDir(fullPath);
  } catch {
    // Skip directories we can't read
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (counters.searchedFiles >= MAX_FILES_TO_SEARCH) break;
    if (!entry.name) continue;

    const entryFullPath = await join(fullPath, entry.name);
    const entryRelativePath = relativePath.endsWith('/')
      ? `${relativePath}${entry.name}`
      : `${relativePath}/${entry.name}`;

    if (entry.isDirectory) {
      await searchRecursive(
        entryFullPath,
        entryRelativePath,
        query,
        searchContent,
        fileExtension,
        results,
        counters,
        maxResults,
        depth + 1
      );
    } else {
      // Check file extension filter
      if (fileExtension && !entry.name.endsWith(`.${fileExtension}`)) {
        continue;
      }

      // Skip non-text files
      if (!isTextFile(entry.name)) {
        continue;
      }

      counters.searchedFiles++;

      // Check filename match
      const filenameMatches = entry.name.toLowerCase().includes(query);
      let contentMatches: MatchInfo[] = [];

      if (searchContent) {
        try {
          const content = await readTextFile(entryFullPath);
          // Skip files that are too large
          if (content.length > MAX_FILE_SIZE) {
            continue;
          }
          contentMatches = findMatches(content, query);
        } catch {
          // Skip files that can't be read
        }
      }

      if (filenameMatches || contentMatches.length > 0) {
        results.push({
          path: entryRelativePath,
          matches: contentMatches,
        });
        counters.totalMatches += Math.max(1, contentMatches.length);
      }
    }
  }
}

function isTextFile(filename: string): boolean {
  const textExtensions = ['md', 'txt', 'yaml', 'yml', 'json', 'js', 'ts', 'css', 'html'];
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? textExtensions.includes(ext) : false;
}

function findMatches(content: string, query: string): MatchInfo[] {
  const matches: MatchInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    const matchIndex = lineLower.indexOf(query);

    if (matchIndex !== -1) {
      // Extract snippet with context
      const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
      const end = Math.min(line.length, matchIndex + query.length + SNIPPET_CONTEXT);
      let snippet = line.slice(start, end);

      if (start > 0) snippet = '...' + snippet;
      if (end < line.length) snippet = snippet + '...';

      matches.push({
        line: i + 1, // 1-indexed
        snippet,
      });
    }
  }

  return matches;
}
