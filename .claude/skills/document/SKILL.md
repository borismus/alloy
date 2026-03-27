---
name: document
description: >-
  Audit and update project documentation. Use when the user says "document",
  "update docs", "check documentation", or after major architectural changes
  that may have made docs stale.
---

# Document

Audit project documentation for staleness, update what's outdated, and flag what's missing.

## Steps

1. **Inventory** — find all doc files: CLAUDE.md, README.md, TECH_DEBT.md, docs/, notes/, style.md, and any project-specific docs.

2. **Audit** — for each doc, check:
   - Does it reference files/features that no longer exist?
   - Does it miss files/features that were recently added?
   - Is any information duplicated across multiple docs?
   - Are links/references still valid?

3. **Update** — fix stale content. Follow these principles:
   - Keep CLAUDE.md stable — conventions and rules only, not feature lists.
   - TECH_DEBT.md — remove resolved items, add new known shortcuts.
   - notes/ — update or create design docs for major changes.
   - README — keep practical (setup, commands, structure).
   - Never duplicate info — reference other docs instead.

4. **Report** — list what was updated, what was added, and what's still missing.

## Rules

- Don't create new doc files unless there's a clear gap. Prefer updating existing ones.
- When removing a TECH_DEBT item, verify the fix is actually in the codebase.
- Design notes (notes/) should include date in filename: `YYYYMMDD-topic.md`.
