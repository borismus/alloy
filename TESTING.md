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

The Playwright MCP server runs in **server mode** — it's not auto-launched with Claude sessions. Start it manually when needed:

### 1. Start the app with the test vault

```bash
VAULT_PATH=tests/fixtures/test-vault npm run web
```

This starts both the API server (port 3001) and Vite dev server (port 1420) pointed at the test vault in `tests/fixtures/test-vault/`.

### 2. Start the Playwright MCP server

```bash
npx @playwright/mcp --port 3100
```

This exposes browser automation tools via SSE at `http://localhost:3100/sse`. The `.mcp.json` is already configured to connect there.

### 3. Use from Claude Code

Once both are running, Claude Code can use the `mcp__playwright__*` tools to navigate, click, fill forms, take screenshots, etc. against the app running with test data.

## Test Vault

The test vault at `tests/fixtures/test-vault/` contains safe fixture data for testing. Add test conversations, notes, and config there as needed.
