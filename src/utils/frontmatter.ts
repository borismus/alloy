import * as yaml from 'js-yaml';

/** Parse YAML frontmatter from markdown content using js-yaml */
export function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  try {
    const frontmatter = (yaml.load(match[1]) as Record<string, any>) || {};
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: {}, body: match[2] };
  }
}

/**
 * Split markdown into its raw frontmatter block (verbatim, including the `---`
 * delimiters and trailing newline) and body. Unlike parseFrontmatter, this does
 * NOT re-serialize the YAML, so `rawFrontmatter + body` reproduces the original
 * bytes exactly when the body is unchanged. Content without frontmatter yields
 * an empty rawFrontmatter and the full content as body.
 */
export function splitFrontmatter(content: string): { rawFrontmatter: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { rawFrontmatter: '', body: content };
  const body = match[2];
  const rawFrontmatter = content.slice(0, content.length - body.length);
  return { rawFrontmatter, body };
}
