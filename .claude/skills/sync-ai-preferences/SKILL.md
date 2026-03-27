# Sync AI Preferences

Syncs global preferences from the Cursor rules file (source of truth) to Claude Code's global CLAUDE.md.

**Source:** `~/.cursor/rules/global-preferences.mdc`
**Target:** `~/.claude/CLAUDE.md`

## Steps

1. Read `~/.cursor/rules/global-preferences.mdc`
2. Transform for Claude Code:
   - Strip MDC frontmatter (the `---` delimited block at the top)
   - Strip bold markdown (`**text**` → `text`)
   - Change heading from "# Global Rules" to "# Global Preferences"
3. Write the result to `~/.claude/CLAUDE.md`
4. Show a brief diff summary of what changed (or "already in sync" if identical)

## When to Use

- After editing `~/.cursor/rules/global-preferences.mdc`
- When the user says "sync preferences", "sync rules", or "sync ai preferences"
