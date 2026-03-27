---
name: tech-debt
description: >-
  Add a tech debt entry to the project's TECH_DEBT.md. Use when the user says
  "debt", "add tech debt", "write this down as tech debt", "track this shortcut",
  or when you take a conscious shortcut during implementation.
---

# Tech Debt

Record a tech debt entry in the project's `TECH_DEBT.md`.

## Steps

1. **Find or create** — look for `TECH_DEBT.md` at the project root. If it doesn't exist:
   - Create it with this header:

   ```markdown
   # Tech Debt

   Consciously taken shortcuts and known issues. **All tech debt taken on must be recorded here.** Each entry must include what was skipped, why, and what to do about it. **Delete entries once resolved** — this file should shrink over time. Do not number entries; order doesn't matter and indices go stale.

   ---
   ```

   - Add a reference to it from the project's `CLAUDE.md` (under an appropriate section like "Important Rules" or "Key Conventions"). Example line: `- **Track Tech Debt** — Known shortcuts and deferred work go in [`TECH_DEBT.md`](./TECH_DEBT.md). All tech debt taken on must be recorded.`

2. **Write the entry** — append a new section using this format:

   ```markdown
   ## <Short descriptive title>

   **What:** <What was skipped or shortcut taken — specific files, behavior, or gap.>

   **Why:** <Why it was done this way — time, scope, complexity, dependency.>

   **Fix:** <Concrete steps to resolve — what to change, what to watch out for.>

   ---
   ```

3. **Confirm** — show the user what was added.

## Rules

- Entries are unnumbered H2 sections separated by `---`. Order doesn't matter.
- Keep each section concise — 1-3 sentences per field.
- The **Fix** field should be actionable, not vague. Mention specific files, functions, or approaches.
- If resolving an existing debt item during implementation, delete that entry from the file.
- Never add items that are feature requests — tech debt is shortcuts taken, not features desired.
