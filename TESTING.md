# Testing

## Full verification gate

Run this before shipping or opening a release PR:

```bash
npm run verify
```

It runs TypeScript typechecking, ESLint, all Vitest tests, all Rust backend tests,
the production web build, and the seeded smoke suite — the same concerns CI checks.

Smoke costs about 45 seconds and needs Playwright browsers
(`npx playwright install chromium webkit`). It earns that: it is the only layer
that notices a renamed CSS class or a moved control, which typechecking, lint,
and unit tests all pass straight through. Set `VERIFY_SKIP_SMOKE=1` to leave it
out while iterating on something it cannot reach.

## Focused tests

```bash
npm run test            # Vitest watch mode
npm run test:run        # All Vitest tests once
npm test -- path/to/file.test.tsx
cargo test --manifest-path alloy-server/Cargo.toml
```

Frontend tests are colocated as `*.test.ts(x)`. Rust tests live beside their
modules under `alloy-server/src/`.

## Seeded smoke tests

```bash
npm run test:smoke
```

This builds the embedded SPA, compiles `alloy-serve`, copies
`tests/smoke/fixture-vault/` into a temporary directory, and drives the real
single-origin backend/app at desktop and mobile-emulated viewports. It needs no
personal vault or provider credentials. Tests live in `tests/smoke/` and use
`playwright.smoke.config.ts`.

Use smoke coverage for behavior that must cross the browser/backend boundary,
such as startup, watcher recovery, full-text search, persistence, and responsive
layout. Native iOS keyboard/rotation behavior still requires physical-device
verification.

## Development E2E tests

```bash
npm run test:e2e
npm run test:e2e:headed
npm run test:e2e:ui
```

These tests live in `tests/e2e/`. `playwright.config.ts` starts `npm run dev`, so
the backend uses the vault selected by `ALLOY_VAULT`/`.env`. Prefer the seeded
smoke suite for CI-safe regression coverage.

## Playwright MCP

`.mcp.json` configures `npx @playwright/mcp` for interactive testing. To use the
safe development fixture:

```bash
ALLOY_VAULT=tests/fixtures/test-vault npm run dev
```

Then drive <http://localhost:1420>. Never point automated destructive tests at a
personal vault.

## CI

`.github/workflows/ci.yml` has separate frontend checks, Rust tests, and seeded
smoke jobs. CI uses Node 24 and the latest stable Rust toolchain.
