import { test, expect, Page } from '@playwright/test';

/**
 * E2E tests for Alloy Tauri app
 *
 * These tests can be run via:
 * 1. Traditional Playwright: npm run test:e2e
 * 2. AI-assisted via MCP: Claude Code can interact with the app using the MCP server
 *
 * Note: Without a configured vault, the app shows the vault setup screen.
 * Tests are organized to handle both states appropriately.
 */

/**
 * Helper to detect current app state
 */
async function getAppState(page: Page): Promise<'vault-setup' | 'main-app'> {
  await page.waitForLoadState('networkidle');

  const vaultSetup = page.locator('.vault-setup');
  if (await vaultSetup.isVisible({ timeout: 2000 }).catch(() => false)) {
    return 'vault-setup';
  }
  return 'main-app';
}

test.describe('Alloy App - Core', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:1420');
  });

  test('should load the app', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Check if the main app container is visible
    const appContainer = page.locator('#root');
    await expect(appContainer).toBeVisible();
  });

  test('should have correct page title', async ({ page }) => {
    const title = await page.title();
    expect(title).toBe('Alloy');
  });

  test('should show either vault setup or main app', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const vaultSetup = page.locator('.vault-setup');
    const mainApp = page.locator('.app-container, .sidebar');

    // One of these should be visible
    const vaultSetupVisible = await vaultSetup.isVisible().catch(() => false);
    const mainAppVisible = await mainApp.first().isVisible().catch(() => false);

    expect(vaultSetupVisible || mainAppVisible).toBe(true);
  });
});

test.describe('Alloy App - Vault Setup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:1420');
  });

  test('vault setup should display welcome message', async ({ page }) => {
    const state = await getAppState(page);
    test.skip(state !== 'vault-setup', 'Vault already configured - skipping setup tests');

    const heading = page.locator('h1');
    await expect(heading).toContainText('Welcome to Alloy');
  });

  test('vault setup should have select folder button', async ({ page }) => {
    const state = await getAppState(page);
    test.skip(state !== 'vault-setup', 'Vault already configured - skipping setup tests');

    const selectButton = page.locator('.select-vault-button');
    await expect(selectButton).toBeVisible();
    await expect(selectButton).toContainText('Select Vault Folder');
  });

  test('vault setup should display privacy-focused messaging', async ({ page }) => {
    const state = await getAppState(page);
    test.skip(state !== 'vault-setup', 'Vault already configured - skipping setup tests');

    const content = await page.content();
    expect(content).toContain('No analytics');
    expect(content).toContain('Your data, your control');
  });
});

test.describe('Alloy App - Main Interface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:1420');
  });

  test('should display the chat interface when vault is configured', async ({ page }) => {
    const state = await getAppState(page);
    test.skip(state !== 'main-app', 'No vault configured - skipping main app tests');

    await page.waitForSelector('.chat-interface', { timeout: 10000 });
    const chatInterface = page.locator('.chat-interface');
    await expect(chatInterface).toBeVisible();
  });

  test('should have a sidebar when vault is configured', async ({ page }) => {
    const state = await getAppState(page);
    test.skip(state !== 'main-app', 'No vault configured - skipping main app tests');

    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
  });

  test('should allow typing in chat input when vault is configured', async ({ page }) => {
    const state = await getAppState(page);
    test.skip(state !== 'main-app', 'No vault configured - skipping main app tests');

    const chatInput = page.locator('textarea').first();
    await chatInput.waitFor({ state: 'visible', timeout: 5000 });
    await chatInput.fill('Test message');
    await expect(chatInput).toHaveValue('Test message');
  });
});

test.describe('Alloy App - Visual Verification', () => {
  test('should render without unexpected console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('http://localhost:1420');
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors:
    // - Network errors in dev mode
    // - Favicon issues
    // - Tauri API errors (expected when running in web mode without Tauri runtime)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('net::') &&
        !e.includes('favicon') &&
        !e.includes('invoke') && // Tauri invoke API
        !e.includes('transformCallback') && // Tauri callback API
        !e.includes('Error loading vault') && // Expected when Tauri APIs unavailable
        !e.includes('Failed to start vault watcher') // Expected when Tauri APIs unavailable
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('should be able to take a screenshot', async ({ page }) => {
    await page.goto('http://localhost:1420');
    await page.waitForLoadState('networkidle');

    const screenshot = await page.screenshot();
    expect(screenshot).toBeTruthy();
    expect(screenshot.length).toBeGreaterThan(1000); // Ensure it's not empty
  });

  test('page content should reference Alloy', async ({ page }) => {
    await page.goto('http://localhost:1420');
    await page.waitForLoadState('networkidle');

    const content = await page.content();
    expect(content).toContain('Alloy');
  });
});
