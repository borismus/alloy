---
name: commit
description: Commit the current working tree into coherent, file-atomic chunks. Use whenever the user asks to commit, stage, or "commit everything" — group changes into logical commits where each file lands in exactly one commit.
---

# commit

Commit the current working tree into coherent commits grouped by feature/concern.

## Rules

1. **Group by concern.** Each commit is one coherent feature/fix. Don't dump unrelated changes together; don't make one giant commit when changes are separable.
2. **Never split a file across commits.** A given file's entire diff goes into exactly one commit. Do NOT use `git add -p` / partial staging. If a file touches two concerns, those concerns merge into one commit (the file forces them together) — pick the grouping that keeps each file whole.
3. **Don't ask permission for obvious groupings.** Just create coherent commits. Only ask if a grouping is genuinely ambiguous or a file looks like it shouldn't be committed.
4. **Exclude by default (mention what you skipped):**
   - Local/personal config: `.claude/settings.local.json`, anything `*.local.*`.
   - Artifacts: screenshots/images created during testing (`*.png` at repo root), build output, logs, temp files.
   - If the user explicitly says to include these, do so.
5. **Honest, concise messages.** Imperative subject line (~50 chars), then a short body explaining the why when non-obvious. If a commit contains pre-existing WIP you didn't author and can't fully vouch for, group it reasonably and say so in your summary to the user.
6. **Branch:** follow the repo's norm. If the project's history commits directly to its default branch (check `git log`), do that; otherwise branch first per harness guidance. Push only if the user asks.

## Procedure

1. `git status --short` and `git diff --stat` (plus `git ls-files --others --exclude-standard` for untracked) to see everything.
2. Skim unfamiliar diffs enough to group and message them honestly.
3. Plan groupings so every file appears in exactly one commit. For each commit, `git add <explicit file paths>` (never `-A`/`-p`) then `git commit`.
4. After committing, run `git status` to confirm only intentionally-excluded files remain, and report the commits + any exclusions to the user.

## Verify

- No file appears in more than one commit (by construction — you staged whole files).
- `git status` afterward shows only the files you deliberately left out.
