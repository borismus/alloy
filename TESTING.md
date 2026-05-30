# Testing

## Unit Tests

```bash
npm run test            # Watch mode
npm run test:run        # Run once
```

## E2E Tests (Playwright)

Standard Playwright tests against the web dev server:

```bash
npm run test:e2e            # Headless
npm run test:e2e:headed     # With browser visible
npm run test:e2e:ui         # Interactive UI mode
```

Tests are in `tests/e2e/`. The Playwright config starts the Vite dev server automatically.

## Playwright MCP (AI-Assisted Testing)

The Playwright MCP server is configured in `.mcp.json` (`npx @playwright/mcp`) and is available to Claude Code automatically — no separate launch step. To drive the app against fixture data, start the backend and SPA pointed at the test vault:

```bash
# Terminal 1: backend on the test vault
cd alloy-server && cargo run --release -- --vault ../tests/fixtures/test-vault --port 3001

# Terminal 2: the SPA (Vite proxies /api to :3001)
npm run dev
```

Then Claude Code can use the `mcp__playwright__*` tools to navigate, click, fill forms, take screenshots, etc. against `http://localhost:1420`.

## Test Vault

The test vault at `tests/fixtures/test-vault/` contains safe fixture data for testing. Add test conversations, notes, and config there as needed.
