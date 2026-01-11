import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Tauri desktop app testing
 * This config allows testing the Tauri app through its webview
 */
export default defineConfig({
  testDir: './tests/e2e',

  // Maximum time one test can run
  timeout: 30 * 1000,

  expect: {
    timeout: 5000
  },

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: 'html',

  use: {
    // Base URL for the Tauri dev server
    baseURL: 'http://localhost:1420',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'tauri-app',
      use: {
        ...devices['Desktop Chrome'],
        // Tauri uses a webview, so we test with Chrome-like settings
        viewport: { width: 1200, height: 800 },
      },
    },
  ],

  // Run your local dev server before starting the tests
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
