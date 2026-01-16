import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';

// Allowlist of secret keys that can be retrieved
const ALLOWED_SECRET_KEYS = [
  'SERPER_API_KEY',
  'OPENWEATHER_API_KEY',
  'SERPAPI_API_KEY',
  // Add more as needed
];

export async function executeSecretTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (toolName !== 'get_secret') {
    return {
      tool_use_id: '',
      content: `Unknown secret tool: ${toolName}`,
      is_error: true,
    };
  }

  const key = input.key as string;
  if (!key) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: key',
      is_error: true,
    };
  }

  // Check if key is in allowlist
  if (!ALLOWED_SECRET_KEYS.includes(key)) {
    return {
      tool_use_id: '',
      content: `Unknown or unauthorized secret key: ${key}. Available keys: ${ALLOWED_SECRET_KEYS.join(', ')}`,
      is_error: true,
    };
  }

  try {
    const config = await vaultService.loadConfig();
    if (!config) {
      return {
        tool_use_id: '',
        content: 'Could not load config',
        is_error: true,
      };
    }

    const value = (config as unknown as Record<string, unknown>)[key] as string | undefined;
    if (!value) {
      return {
        tool_use_id: '',
        content: `Secret ${key} is not configured. Add it to your config.yaml file.`,
        is_error: true,
      };
    }

    return {
      tool_use_id: '',
      content: value,
    };
  } catch (error) {
    return {
      tool_use_id: '',
      content: `Error retrieving secret: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}
