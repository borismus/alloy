// Slash-command parsing for `/skill_name [args]` invocation in the composer.

export interface ParsedSlashCommand {
  /** The command name (the skill to invoke), e.g. "research". */
  name: string;
  /** Everything after the command name, trimmed (may be empty). */
  args: string;
}

/**
 * Parse a leading `/skill_name [args]` command. Returns null when the input
 * isn't a slash command (doesn't start with `/`, is just `/`, etc.). The command
 * name is the first whitespace-delimited token after the slash.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const m = input.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

/**
 * The partial command name while the user is still typing it (leading `/` with
 * no space yet) — used to open/filter the autocomplete menu. Returns null once
 * a space is typed or the input isn't a leading slash token. `/` alone yields
 * an empty string (show the full list).
 */
export function slashQuery(input: string): string | null {
  const m = input.match(/^\/(\S*)$/);
  return m ? m[1] : null;
}
