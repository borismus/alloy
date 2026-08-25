# Frontend test support

Project-wide commands and test-layer guidance live in [TESTING.md](../../TESTING.md).

This directory contains shared Vitest infrastructure rather than the tests
themselves:

- `setup.ts` installs the happy-dom environment and common browser/Tauri mocks.
- `mocks.ts` provides reusable fixture factories.

Frontend tests are colocated with production code as `*.test.ts` or
`*.test.tsx`. Component interaction tests use Testing Library; backend protocol,
persistence, tools, and scheduler behavior belong in Rust tests under
`alloy-server/src/`. Cross-runtime behavior belongs in the seeded Playwright
smoke suite under `tests/smoke/`.
