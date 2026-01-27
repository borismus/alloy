import { fetch } from '@tauri-apps/plugin-http';
import { ToolResult } from '../../../types/tools';
import { vaultService } from '../../vault';

const HTTP_TIMEOUT = 30000; // 30 seconds

// Resolve secret tokens like ${{SERPER_API_KEY}} to their actual values
async function resolveSecretTokens(text: string): Promise<string> {
  const pattern = /\$\{\{([A-Z_]+)\}\}/g;
  const matches = [...text.matchAll(pattern)];

  if (matches.length === 0) {
    return text;
  }

  const config = await vaultService.loadConfig();
  if (!config) {
    return text;
  }

  let result = text;
  for (const match of matches) {
    const [token, keyName] = match;
    const value = (config as unknown as Record<string, unknown>)[keyName] as string | undefined;
    if (value) {
      result = result.replace(token, value);
    }
  }
  return result;
}

export async function executeHttpTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'http_get':
      return await httpGet(input.url as string);
    case 'http_post':
      return await httpPost(
        input.url as string,
        input.body as string,
        input.headers as string | undefined
      );
    default:
      return {
        tool_use_id: '',
        content: `Unknown HTTP tool: ${toolName}`,
        is_error: true,
      };
  }
}

async function httpGet(url: string): Promise<ToolResult> {
  if (!url) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: url',
      is_error: true,
    };
  }

  try {
    // Resolve any secret tokens in the URL
    const resolvedUrl = await resolveSecretTokens(url);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

    const response = await fetch(resolvedUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        tool_use_id: '',
        content: `HTTP error: ${response.status} ${response.statusText}`,
        is_error: true,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    let content: string;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
    } else {
      content = await response.text();
    }

    // Truncate very long responses
    const maxLength = 50000;
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n\n[Content truncated...]';
    }

    return {
      tool_use_id: '',
      content,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        tool_use_id: '',
        content: 'Request timed out after 30 seconds',
        is_error: true,
      };
    }
    return {
      tool_use_id: '',
      content: `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}

async function httpPost(
  url: string,
  body: string,
  headersJson?: string
): Promise<ToolResult> {
  if (!url) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: url',
      is_error: true,
    };
  }

  if (!body) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: body',
      is_error: true,
    };
  }

  try {
    // Resolve any secret tokens in URL and body
    const resolvedUrl = await resolveSecretTokens(url);
    const resolvedBody = await resolveSecretTokens(body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

    // Parse custom headers if provided
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (headersJson) {
      try {
        // Resolve secret tokens in headers before parsing
        const resolvedHeadersJson = await resolveSecretTokens(headersJson);
        const customHeaders = JSON.parse(resolvedHeadersJson);
        Object.assign(headers, customHeaders);
      } catch {
        return {
          tool_use_id: '',
          content: 'Invalid headers JSON format',
          is_error: true,
        };
      }
    }

    const response = await fetch(resolvedUrl, {
      method: 'POST',
      headers,
      body: resolvedBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        tool_use_id: '',
        content: `HTTP error: ${response.status} ${response.statusText}`,
        is_error: true,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    let content: string;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
    } else {
      content = await response.text();
    }

    // Truncate very long responses
    const maxLength = 50000;
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n\n[Content truncated...]';
    }

    return {
      tool_use_id: '',
      content,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        tool_use_id: '',
        content: 'Request timed out after 30 seconds',
        is_error: true,
      };
    }
    return {
      tool_use_id: '',
      content: `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}
