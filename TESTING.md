# Testing Guide: Playwright MCP Integration

This guide explains how to use the Playwright MCP (Model Context Protocol) server integration to test the Alloy Tauri app with AI assistance.

## Overview

The Playwright MCP server allows Claude Code to interact with your Tauri app's UI through browser automation. This enables:

- AI-assisted UI testing and exploration
- Dynamic test case generation
- Visual regression testing with screenshots
- Interactive debugging and exploration

## Setup

All dependencies are already installed. The MCP server configuration is in [.mcp.json](./.mcp.json).

### Files Created

- **[mcp-server/playwright-server.ts](mcp-server/playwright-server.ts)** - MCP server that exposes Playwright capabilities
- **[playwright.config.ts](playwright.config.ts)** - Playwright configuration for Tauri app
- **[tests/e2e/app.spec.ts](tests/e2e/app.spec.ts)** - Example E2E tests
- **[.mcp.json](./.mcp.json)** - MCP server configuration

## Traditional Playwright Testing

Run standard Playwright tests:

```bash
# Run all E2E tests (headless)
npm run test:e2e

# Run tests with UI mode (interactive)
npm run test:e2e:ui

# Run tests with browser visible (headed mode)
npm run test:e2e:headed
```

## AI-Assisted Testing via MCP

The MCP server exposes these tools to Claude Code:

### Available MCP Tools

1. **browser_navigate** - Navigate to a URL
   ```
   Navigate to http://localhost:1420
   ```

2. **browser_click** - Click an element
   ```
   Click the element with selector: button.primary
   ```

3. **browser_fill** - Fill in a form field
   ```
   Fill the input field #username with "testuser"
   ```

4. **browser_screenshot** - Take a screenshot
   ```
   Take a screenshot and save it to ./screenshots/test.png
   ```

5. **browser_evaluate** - Execute JavaScript
   ```
   Evaluate: document.querySelector('h1').textContent
   ```

6. **browser_get_text** - Get text content
   ```
   Get text from selector: .chat-message
   ```

7. **browser_wait_for_selector** - Wait for element
   ```
   Wait for selector: .loading-complete
   ```

8. **browser_close** - Close the browser
   ```
   Close the browser
   ```

## Usage Examples

### Example 1: AI-Driven UI Exploration

You can ask Claude Code to explore your app:

```
"Explore the Alloy UI and tell me what features are available"
```

Claude Code will use the MCP server to:
1. Navigate to the app
2. Take screenshots
3. Interact with elements
4. Analyze the UI structure
5. Report findings

### Example 2: Interactive Testing

```
"Test the chat functionality by typing a message and submitting it"
```

Claude Code will:
1. Find the chat input
2. Fill in a test message
3. Click the submit button
4. Verify the message appears
5. Take screenshots of the results

### Example 3: Visual Regression

```
"Take screenshots of the main UI states for visual regression testing"
```

Claude Code will navigate through your app and capture screenshots of different states.

## How It Works

1. **MCP Server**: The TypeScript server in `mcp-server/playwright-server.ts` runs as a background process
2. **Protocol**: It communicates with Claude Code via the MCP protocol
3. **Browser Automation**: Uses Playwright to control a browser instance
4. **Tools**: Exposes browser automation capabilities as MCP tools
5. **AI Integration**: Claude Code uses these tools to interact with your UI

## Configuration

### MCP Server Configuration (.mcp.json)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["--loader", "tsx", "mcp-server/playwright-server.ts"]
    }
  }
}
```

### Enabling the MCP Server

The MCP server is configured in [.mcp.json](./.mcp.json). Claude Code will detect it automatically when you start a session in this directory.

You may need to approve the MCP server when prompted by Claude Code.

## Development Workflow

### 1. Start Development Server

```bash
npm run dev
```

This starts the Tauri app at `http://localhost:1420`.

### 2. Use AI-Assisted Testing

In Claude Code, you can now ask questions like:

- "Test the prompt creation workflow"
- "Take screenshots of all the main screens"
- "Check if the chat interface is working correctly"
- "Find any UI elements that aren't accessible"
- "Test the vault integration"

### 3. Run Traditional Tests

```bash
npm run test:e2e
```

## Best Practices

1. **Keep the dev server running** - The MCP server connects to `http://localhost:1420`
2. **Use descriptive selectors** - Help Claude Code find elements easily
3. **Take screenshots** - Visual feedback helps with debugging
4. **Close the browser** - Use `browser_close` when done to clean up resources
5. **Combine approaches** - Use both traditional tests and AI-assisted exploration

## Troubleshooting

### MCP Server Not Starting

- Check that all dependencies are installed: `npm install`
- Verify [.mcp.json](./.mcp.json) exists and is valid
- Restart Claude Code

### Browser Not Opening

- Ensure Chromium is installed: `npm run playwright:install`
- Check if port 1420 is available
- Verify the dev server is running: `npm run dev`

### Selectors Not Working

- Use browser dev tools to inspect elements
- Try more specific selectors
- Use text-based selectors: `text=Submit`
- Ask Claude Code to help find the right selector

## Advanced Usage

### Custom Test Scenarios

You can ask Claude Code to create custom test scenarios:

```
"Create a test that:
1. Opens the app
2. Creates a new prompt
3. Sends it to Claude
4. Verifies the response appears
5. Takes screenshots at each step"
```

### Integration with CI/CD

The traditional Playwright tests can run in CI:

```yaml
# .github/workflows/test.yml
- name: Install dependencies
  run: npm ci

- name: Install Playwright
  run: npm run playwright:install

- name: Run E2E tests
  run: npm run test:e2e
```

## Learning More

- [Playwright Documentation](https://playwright.dev)
- [MCP Documentation](https://modelcontextprotocol.io)
- [Tauri Testing Guide](https://tauri.app/v1/guides/testing/)

## Tips for AI-Assisted Testing

1. **Be specific**: "Click the blue submit button in the chat interface"
2. **Request screenshots**: "Take a screenshot after each step"
3. **Ask for analysis**: "What do you see in the current UI?"
4. **Iterate**: "Now try clicking the sidebar menu"
5. **Verify state**: "Check if the message was sent successfully"

The combination of traditional Playwright tests and AI-assisted MCP testing gives you powerful, flexible testing capabilities for your Tauri app!
