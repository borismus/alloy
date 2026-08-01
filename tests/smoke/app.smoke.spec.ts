import { test, expect } from '@playwright/test';

// These run against the seeded fixture vault (tests/smoke/fixture-vault) served
// by a real alloy-serve backend. They assert the app renders with data and the
// core surfaces work — at both desktop and mobile viewports (see the projects
// in playwright.smoke.config.ts).

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The SPA loads config + conversations from /api on boot.
  await expect(page.locator('.timeline-item').first()).toBeVisible();
});

test('renders the seeded vault instead of the setup screen', async ({ page }) => {
  await expect(page.locator('.vault-setup')).toHaveCount(0);
  await expect(page.getByText('Welcome to Alloy')).toBeVisible();
  await expect(page.getByText('Planning the week')).toBeVisible();
  expect(await page.locator('.timeline-item').count()).toBeGreaterThanOrEqual(4);
});

test('opens a conversation and shows the composer and model picker', async ({ page }) => {
  await page.getByText('Welcome to Alloy').click();

  await expect(page.locator('.input-row textarea')).toBeVisible();
  await expect(page.getByText('What can Alloy do?')).toBeVisible();

  const picker = page.locator('.model-selector-container button');
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByRole('option').filter({ hasText: /Claude/ }).first()).toBeVisible();
});

test('a failed model discovery does not claim the vault has no provider', async ({ page }) => {
  // Regression: `hasProvider` used to be derived from the live catalog, so a
  // transient discovery failure (the endpoint answers 200 with []) replaced the
  // whole chat UI with "No Provider Configured" even though config.yaml
  // declares providers. Discovery is also no longer awaited before first paint,
  // so this state is reachable on every cold start.
  await page.route('**/api/models', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.reload();

  await expect(page.locator('.timeline-item').first()).toBeVisible();
  await page.getByText('Welcome to Alloy').click();

  await expect(page.locator('.no-provider')).toHaveCount(0);
  await expect(page.locator('.input-row textarea')).toBeVisible();
});

test('an empty catalog refresh does not wipe already-loaded models', async ({ page }) => {
  // Regression: the periodic refresh (fires on focus/visibilitychange, i.e.
  // constantly on mobile) overwrote a good catalog with an empty one, blanking
  // the picker until reload.
  await page.getByText('Welcome to Alloy').click();
  const picker = page.locator('.model-selector-container button');
  await expect(picker).toBeVisible();
  const labelBefore = await picker.textContent();

  await page.route('**/api/models', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);

  await expect(page.locator('.no-provider')).toHaveCount(0);
  await expect(picker).toHaveText(labelBefore ?? '');
  await picker.click();
  await expect(page.getByRole('option').filter({ hasText: /Claude/ }).first()).toBeVisible();
});

test('dark mode keeps syntax-highlighted code legible', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('alloy.theme', 'dark'));
  await page.reload();
  await expect(page.locator('.timeline-item').first()).toBeVisible();
  await page.getByText('Welcome to Alloy').click();

  const code = page.locator('.code-block').first();
  await expect(code).toBeVisible();
  const minimumContrast = await code.evaluate((block) => {
    const parseRgb = (value: string): number[] =>
      value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const background = luminance(parseRgb(getComputedStyle(block).backgroundColor));
    return ['.hljs-attr', '.hljs-comment'].map((selector) => {
      const token = block.querySelector(selector);
      if (!token) return 0;
      const foreground = luminance(parseRgb(getComputedStyle(token).color));
      return (Math.max(foreground, background) + 0.05)
        / (Math.min(foreground, background) + 0.05);
    }).reduce((minimum, contrast) => Math.min(minimum, contrast), Infinity);
  });
  expect(minimumContrast).toBeGreaterThanOrEqual(4.5);
});

test('mobile: the composer stays within two rows', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only layout check');

  await page.getByText('Welcome to Alloy').click();
  await expect(page.locator('.input-row textarea')).toBeVisible();

  // Distinct vertical positions of the *visible* composer controls (the hidden
  // file input is display:none → excluded). More than two means it has wrapped
  // into an extra line, the regression this guards against.
  const rowCount = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.input-row > *')].filter(
      (el) => (el as HTMLElement).offsetParent !== null,
    );
    const tops = new Set(visible.map((el) => Math.round(el.getBoundingClientRect().top)));
    return tops.size;
  });
  expect(rowCount).toBeLessThanOrEqual(2);
});
