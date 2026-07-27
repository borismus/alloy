import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite: boots the real standalone backend (alloy-serve) against a seeded
 * fixture vault and runs a handful of assertions at desktop and mobile
 * viewports. This is the layer unit tests can't reach — does the app actually
 * render with data, and does the mobile layout hold up.
 *
 * Run with `npm run test:smoke` (builds dist-web, then this config's webServer
 * boots alloy-serve via scripts/smoke-server.sh on a dedicated port).
 */
const PORT = process.env.SMOKE_PORT || '4319';
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 800 } },
    },
    {
      // Mobile-emulated Chromium (viewport + touch + hover:none) so we only need
      // the chromium install; catches the layout/touch regressions that unit
      // tests miss.
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 780 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: 'bash scripts/smoke-server.sh',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { SMOKE_PORT: PORT },
  },
});
