---
name: verify
description: >-
  Run the full verification pipeline and fix issues. Use when the user says
  "verify", "run checks", "check everything", "any test needed", or wants
  confirmation that recent changes are clean.
---

# Verify

Run all available checks, fix issues introduced by recent changes, and report results.

## Steps

1. **Type-check** — run `pnpm run type-check` (or project equivalent). Fix any errors from recent changes.

2. **Lint** — run `pnpm run lint` (or project equivalent). Fix errors introduced by recent changes. Ignore pre-existing warnings unless they're in files you modified.

3. **Tests** — run `pnpm test` (or project equivalent). If tests fail due to recent changes, fix them. If tests are missing for new functionality, flag it but don't write tests unless asked.

4. **Build** — run `CHECK_BUILD=1 pnpm run build` (or project equivalent) if available. Fix build errors.

5. **Report** — summarize results in a compact table:

```
| Check      | Result        |
|------------|---------------|
| Type-check | ✓ clean       |
| Lint       | ✓ 0 errors    |
| Tests      | ✓ 62/62 pass  |
| Build      | ✓ compiled    |
```

## Rules

- Run checks in parallel when they're independent (type-check and lint can run together).
- Only fix issues you introduced. Don't fix pre-existing problems unless they block the pipeline.
- If a check doesn't exist in the project (no test script, no type-check), skip it and note it.
