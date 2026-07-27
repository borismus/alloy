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
