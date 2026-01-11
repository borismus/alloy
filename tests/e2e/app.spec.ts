import { test, expect } from '@playwright/test';

/**
 * Example E2E test for PromptBox Tauri app
 *
 * These tests can be run via:
 * 1. Traditional Playwright: npm run test:e2e
 * 2. AI-assisted via MCP: Claude Code can interact with the app using the MCP server
 */

test.describe('PromptBox App', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the Tauri app (dev server)
    await page.goto('http://localhost:1420');
  });

  test('should load the app', async ({ page }) => {
    // Wait for the app to load
    await page.waitForLoadState('networkidle');

    // Check if the main app container is visible
    const appContainer = page.locator('#root');
    await expect(appContainer).toBeVisible();
  });

  test('should display the chat interface', async ({ page }) => {
    // Wait for chat interface to be rendered
    await page.waitForSelector('.chat-interface', { timeout: 10000 });

    // Verify chat interface elements exist
    const chatInterface = page.locator('.chat-interface');
    await expect(chatInterface).toBeVisible();
  });

  test('should have a sidebar', async ({ page }) => {
    // Check if sidebar is present
    const sidebar = page.locator('.sidebar, [class*="sidebar"]');
    await expect(sidebar).toBeVisible();
  });

  test('should allow typing in chat input', async ({ page }) => {
    // Find the chat input field (adjust selector based on your actual implementation)
    const chatInput = page.locator('textarea, input[type="text"]').first();

    if (await chatInput.isVisible()) {
      await chatInput.fill('Test message');
      await expect(chatInput).toHaveValue('Test message');
    }
  });
});

test.describe('AI-assisted testing examples', () => {
  test('navigation example', async ({ page }) => {
    // This demonstrates what the MCP server can do
    await page.goto('http://localhost:1420');

    // Take a screenshot for AI to analyze
    const screenshot = await page.screenshot();
    expect(screenshot).toBeTruthy();
  });

  test('interaction example', async ({ page }) => {
    await page.goto('http://localhost:1420');

    // Get page title and content for AI analysis
    const title = await page.title();
    const content = await page.content();

    expect(title).toBeTruthy();
    expect(content).toContain('PromptBox');
  });
});
