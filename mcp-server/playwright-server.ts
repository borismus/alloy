#!/usr/bin/env node

/**
 * Playwright MCP Server
 *
 * This server exposes Playwright browser automation capabilities via MCP protocol,
 * allowing Claude Code to interact with and test the Tauri app UI.
 *
 * Available tools:
 * - browser_navigate: Navigate to a URL
 * - browser_click: Click an element
 * - browser_fill: Fill in a form field
 * - browser_screenshot: Take a screenshot
 * - browser_evaluate: Execute JavaScript in the page
 * - browser_get_text: Get text content from an element
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium, Browser, Page, BrowserContext } from '@playwright/test';

// Global state
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
    });
    page = await context.newPage();
  }
  return { browser, context, page: page! };
}

// Cleanup
async function cleanup() {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

const server = new Server(
  {
    name: 'playwright-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'browser_navigate',
        description: 'Navigate the browser to a URL',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to navigate to (e.g., http://localhost:1420)',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'browser_click',
        description: 'Click an element on the page using a selector',
        inputSchema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector or text selector for the element to click',
            },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_fill',
        description: 'Fill in a form field',
        inputSchema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the input field',
            },
            value: {
              type: 'string',
              description: 'The value to fill in',
            },
          },
          required: ['selector', 'value'],
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current page',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to save the screenshot (optional)',
            },
            fullPage: {
              type: 'boolean',
              description: 'Capture the full page (default: false)',
            },
          },
        },
      },
      {
        name: 'browser_evaluate',
        description: 'Execute JavaScript in the page context',
        inputSchema: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description: 'JavaScript code to execute',
            },
          },
          required: ['script'],
        },
      },
      {
        name: 'browser_get_text',
        description: 'Get text content from an element',
        inputSchema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the element',
            },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_wait_for_selector',
        description: 'Wait for an element to appear on the page',
        inputSchema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector to wait for',
            },
            timeout: {
              type: 'number',
              description: 'Maximum wait time in milliseconds (default: 5000)',
            },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_close',
        description: 'Close the browser',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'browser_navigate': {
        const { page } = await initBrowser();
        await page.goto(args.url as string);
        return {
          content: [
            {
              type: 'text',
              text: `Navigated to ${args.url}`,
            },
          ],
        };
      }

      case 'browser_click': {
        const { page } = await initBrowser();
        await page.click(args.selector as string);
        return {
          content: [
            {
              type: 'text',
              text: `Clicked element: ${args.selector}`,
            },
          ],
        };
      }

      case 'browser_fill': {
        const { page } = await initBrowser();
        await page.fill(args.selector as string, args.value as string);
        return {
          content: [
            {
              type: 'text',
              text: `Filled ${args.selector} with: ${args.value}`,
            },
          ],
        };
      }

      case 'browser_screenshot': {
        const { page } = await initBrowser();
        const screenshot = await page.screenshot({
          path: args.path as string | undefined,
          fullPage: args.fullPage as boolean | undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: args.path
                ? `Screenshot saved to ${args.path}`
                : 'Screenshot captured',
            },
            {
              type: 'image',
              data: screenshot.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      }

      case 'browser_evaluate': {
        const { page } = await initBrowser();
        const result = await page.evaluate(args.script as string);
        return {
          content: [
            {
              type: 'text',
              text: `Evaluation result: ${JSON.stringify(result, null, 2)}`,
            },
          ],
        };
      }

      case 'browser_get_text': {
        const { page } = await initBrowser();
        const text = await page.textContent(args.selector as string);
        return {
          content: [
            {
              type: 'text',
              text: text || '',
            },
          ],
        };
      }

      case 'browser_wait_for_selector': {
        const { page } = await initBrowser();
        await page.waitForSelector(args.selector as string, {
          timeout: (args.timeout as number) || 5000,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Element found: ${args.selector}`,
            },
          ],
        };
      }

      case 'browser_close': {
        await cleanup();
        return {
          content: [
            {
              type: 'text',
              text: 'Browser closed',
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
