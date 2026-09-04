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

test('positions creation actions responsively and keeps the riff command reachable', async ({ page }, testInfo) => {
  const header = page.locator('.mobile-sidebar-header');
  const searchRow = page.locator('.search-box');
  const newConversation = page.getByRole('button', { name: 'New conversation' });
  const creationOverflow = page.getByRole('button', { name: 'More creation options' });

  if (testInfo.project.name === 'mobile') {
    await expect(header).toBeVisible();
    await expect(header.getByRole('button', { name: 'New conversation' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'More creation options' })).toBeVisible();
    await expect(searchRow.getByRole('button', { name: 'New conversation' })).toHaveCount(0);

    const plusBox = await newConversation.boundingBox();
    const overflowBox = await creationOverflow.boundingBox();
    expect(plusBox?.width).toBeGreaterThanOrEqual(40);
    expect(plusBox?.height).toBeGreaterThanOrEqual(40);
    expect(overflowBox?.width).toBeGreaterThanOrEqual(40);
    expect(overflowBox?.height).toBeGreaterThanOrEqual(40);
  } else {
    await expect(header).toHaveCount(0);
    await expect(searchRow.getByRole('button', { name: 'New conversation' })).toBeVisible();
    await expect(searchRow.getByRole('button', { name: 'More creation options' })).toBeVisible();
  }

  await creationOverflow.click();
  await expect(page.getByRole('menuitem', { name: 'New riff' })).toBeVisible();
});

test('opens a conversation and shows the composer and model picker', async ({ page }, testInfo) => {
  await page.getByText('Welcome to Alloy').click();

  await expect(page.locator('.input-row textarea')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice input' })).toBeVisible();
  await expect(page.getByText('What can Alloy do?')).toBeVisible();

  const picker = page.locator('.model-selector-container button');
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByRole('option').filter({ hasText: /Claude/ }).first()).toBeVisible();
  const defaultRow = page.getByRole('option').filter({ hasText: /Claude Sonnet/ });
  await expect(defaultRow).toHaveAttribute('data-default', 'true');
  await expect(defaultRow.getByRole('img', { name: 'Default model' })).toBeVisible();
  await expect(defaultRow.getByRole('button', { name: /favorites/i })).toHaveCount(0);

  await page.getByRole('searchbox', { name: 'Search models' }).fill('opus');
  const opusRow = page.getByRole('option').filter({ hasText: /Claude Opus/ }).first();
  const setDefault = opusRow.getByRole('button', { name: /Set Claude Opus.* as default/i });
  await expect(setDefault).toBeAttached();
  if (testInfo.project.name === 'mobile') {
    await expect(setDefault).toHaveCSS('opacity', '1');
  } else {
    await opusRow.hover();
    await expect(setDefault).toHaveCSS('opacity', '1');
  }
});

test('new conversations use the configured default before and after discovery', async ({ page }) => {
  const configResponse = await page.request.get('/api/config');
  const baseConfig = await configResponse.json();
  await page.route('**/api/config', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ...baseConfig,
      defaultModel: 'claude-cli/sonnet',
      favoriteModels: ['claude-cli/opus'],
    }),
  }));

  // Startup path: discovery has not produced a usable catalog.
  await page.route('**/api/models', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '[]',
  }));
  await page.reload();
  await expect(page.locator('.timeline-item').first()).toBeVisible();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.locator('.model-selector-container button[aria-label^="Model:"]'))
    .toHaveAttribute('aria-label', /Sonnet/i);

  // Live-catalog path: the configured default is available alongside a
  // favorite. It must still win instead of choosing the favorite at random.
  // Drop the draft selection persisted by the click above; restoring it would
  // start mobile in the conversation view, where the timeline list is hidden.
  await page.evaluate(() => localStorage.removeItem('alloy.selectedItem'));
  await page.unroute('**/api/models');
  const discovered = page.waitForResponse(response =>
    response.url().includes('/api/models') && response.ok()
  );
  await page.reload();
  await discovered;
  await expect(page.locator('.timeline-item').first()).toBeVisible();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.locator('.model-selector-container button[aria-label^="Model:"]'))
    .toHaveAttribute('aria-label', /Sonnet/i);
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

test('focus does not reload the conversation or lose scroll position', async ({ page }) => {
  // Real vault timestamps are unquoted YAML scalars. With js-yaml's default
  // schema, separately parsing the summary and full conversation made equal
  // timestamps into unequal Date objects, so every focus forced a reload.
  await page.getByText('Focus scroll regression', { exact: true }).click();
  await expect(page.getByText('Paragraph 20:', { exact: false })).toBeAttached();
  await expect(page.locator('.loading-conversation')).toHaveCount(0);

  const before = await page.locator('.messages-container').evaluate(el => {
    const container = el as HTMLElement;
    container.scrollTop = Math.floor((container.scrollHeight - container.clientHeight) / 2);
    container.dispatchEvent(new Event('scroll'));
    (window as unknown as { __sawFocusReload?: boolean }).__sawFocusReload = false;
    new MutationObserver(() => {
      if (document.querySelector('.loading-conversation')) {
        (window as unknown as { __sawFocusReload?: boolean }).__sawFocusReload = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
    return container.scrollTop;
  });
  expect(before).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1_000); // 250ms resync debounce + vault reads

  const state = await page.locator('.messages-container').evaluate(el => ({
    scrollTop: (el as HTMLElement).scrollTop,
    sawReload: (window as unknown as { __sawFocusReload?: boolean }).__sawFocusReload,
  }));
  expect(state.sawReload).toBe(false);
  expect(state.scrollTop).toBe(before);
});

test('resyncs vault changes missed while the watcher was disconnected', async ({ page }, testInfo) => {
  // Regression: the watcher reconnects but never re-reads the vault, so every
  // change made during the gap was lost until a manual reload. Mobile hits this
  // constantly (screen lock / app switch kills the socket).
  // Track sockets so the test can tear one down the way iOS does. Test-local:
  // no production hook, and it must be installed before the app connects.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    (window as unknown as { __sockets: WebSocket[] }).__sockets = [];
    class TrackedWebSocket extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as unknown as { __sockets: WebSocket[] }).__sockets.push(this);
      }
    }
    window.WebSocket = TrackedWebSocket as unknown as typeof WebSocket;
  });
  await page.reload();
  await expect(page.locator('.timeline-item').first()).toBeVisible();

  const before = await page.locator('.timeline-item').count();

  // Drop the socket, then change the vault while it's down. Closing from the
  // page side mirrors the OS tearing it down, and unlike stopping the server it
  // leaves /api writable so the fixture can still be modified.
  await page.evaluate(() =>
    (window as unknown as { __sockets: WebSocket[] }).__sockets.forEach(s => s.close())
  );

  // Unique per project: desktop and mobile run sequentially against the SAME
  // server and vault copy, so a shared filename would already exist on the
  // second run and the count would not change.
  const id = `2024-05-05-1200-ww${testInfo.project.name === 'mobile' ? '02' : '01'}`;
  const title = `missed while offline ${testInfo.project.name}`;
  await page.request.post('/api/fs/writeTextFile', {
    data: {
      path: `/conversations/${id}-missed-while-offline.yaml`,
      content: [
        `id: ${id}`,
        `title: ${title}`,
        'model: claude-cli/sonnet',
        'created: 2024-05-05T12:00:00.000Z',
        'updated: 2024-05-05T12:00:00.000Z',
        'messages: []',
        '',
      ].join('\n'),
    },
  });

  // No focus event on purpose: this asserts the RECONNECT trigger specifically.
  // The client retries ~3s after close, then resyncs.
  await expect(page.locator('.timeline-item')).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(page.getByText(title)).toBeVisible();
});

test('model picker does not raise the keyboard on open (mobile)', async ({ page }, testInfo) => {
  // Regression: autofocusing the search field popped the iOS software keyboard,
  // which resized the visual viewport and moved the composer several hundred px.
  // React Aria had already positioned the popover against the pre-keyboard
  // layout, stranding it under the keyboard with only the search box visible.
  // Focus is the observable proxy for "keyboard would open" — a headless browser
  // has no software keyboard, so the viewport race itself cannot be reproduced.
  await page.getByText('Welcome to Alloy').click();
  await page.locator('.model-selector-container button').click();

  const search = page.getByRole('searchbox', { name: 'Search models' });
  await expect(search).toBeVisible();

  const focused = await search.evaluate((el) => el === document.activeElement);
  if (testInfo.project.name === 'mobile') {
    expect(focused, 'search must not autofocus on mobile').toBe(false);
    // Typing still works once the field is explicitly tapped.
    await search.click();
    await search.fill('claude');
    await expect(page.getByRole('option').first()).toBeVisible();
  } else {
    expect(focused, 'desktop keeps type-to-search').toBe(true);
  }
});

test('restores the open conversation after the tab session ends', async ({ page }) => {
  // Regression: the selection lived in sessionStorage, which is discarded when
  // the tab session ends — exactly what iOS does to a backgrounded tab and what
  // a desktop app restart looks like. So it was lost precisely when restoring it
  // mattered. A plain reload keeps sessionStorage, which is why this never
  // showed up in normal testing.
  await page.getByText('Welcome to Alloy').click();
  await expect(page.getByText('What can Alloy do?')).toBeVisible();

  await page.evaluate(() => sessionStorage.clear());
  await page.reload();

  await expect(page.getByText('What can Alloy do?')).toBeVisible();
});

test('mobile can send from a new conversation after iOS-style restoration', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only lifecycle regression');

  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.locator('.input-row textarea')).toBeVisible();
  const selected = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('alloy.selectedItem') ?? 'null') as { id?: string } | null
  );
  expect(selected?.id).toBeTruthy();

  // iOS may terminate the web-content process while the app is backgrounded.
  // The selected id survives in localStorage, but an empty conversation has no
  // vault file yet and its backing draft previously existed only in React state.
  await page.reload();
  const textarea = page.locator('.input-row textarea');
  await expect(textarea).toBeVisible();

  // Stop before any real provider call. A 503 also exercises the existing error
  // recovery, which should put the accepted prompt back into the composer.
  await page.route('**/api/stream/start', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'intentional lifecycle regression response' }),
  }));

  const prompt = 'This restored draft must reach the send pipeline';
  await textarea.fill(prompt);
  const startRequest = page.waitForRequest(request => request.url().endsWith('/api/stream/start'));
  await page.getByRole('button', { name: 'Send message' }).click();
  const request = await startRequest;
  expect(request.postDataJSON().conversationId).toBe(selected?.id);
  await expect(textarea).toHaveValue(prompt);
});

test('search finds text inside conversation bodies', async ({ page }) => {
  // Regression: the sidebar filter searched `conversation.messages`, but
  // conversations load as metadata-only summaries with messages: [], so the
  // full-text branch matched nothing until a conversation had been opened.
  // The scan now runs server-side against the vault files.
  const search = page.locator('input[placeholder*="Search"]');

  // 'configuration' appears only in the seeded conversation's code block.
  await search.fill('configuration');
  await expect(page.getByText('Welcome to Alloy')).toBeVisible();
  // The API's context is rendered, not discarded after reducing results to ids.
  await expect(page.getByText('# Example configuration')).toBeVisible();

  await search.fill('zzznotpresentanywhere');
  await expect(page.locator('.timeline-item')).toHaveCount(0);
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
