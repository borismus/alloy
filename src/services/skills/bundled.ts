import { Skill, SkillMetadata } from '../../types/skills';

// Import all SKILL.md files from skills/ directory at build time
const skillModules = import.meta.glob('/skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// Parse YAML frontmatter from markdown content
function parseFrontmatter(content: string): { metadata: SkillMetadata | null; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: null, body: content };
  }

  const [, frontmatterRaw, body] = match;

  // Simple YAML parser for our use case (just name and description)
  const metadata: Partial<SkillMetadata> = {};

  for (const line of frontmatterRaw.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === 'name') {
      metadata.name = value;
    } else if (key === 'description') {
      metadata.description = value;
    }
  }

  if (!metadata.name || !metadata.description) {
    return { metadata: null, body: content };
  }

  return {
    metadata: metadata as SkillMetadata,
    body: body.trim(),
  };
}

// Load all bundled skills from the skills/ directory
export function loadBundledSkills(): Skill[] {
  const skills: Skill[] = [];

  for (const [path, content] of Object.entries(skillModules)) {
    const { metadata, body } = parseFrontmatter(content);

    if (!metadata) {
      console.warn(`Invalid SKILL.md frontmatter at ${path}`);
      continue;
    }

    skills.push({
      ...metadata,
      instructions: body,
      path: '__bundled__',
    });
  }

  return skills;
}
