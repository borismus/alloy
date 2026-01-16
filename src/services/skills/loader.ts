import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { Skill, SkillMetadata } from '../../types/skills';

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

export async function loadSkillFromPath(skillPath: string): Promise<Skill | null> {
  try {
    const skillMdPath = await join(skillPath, 'SKILL.md');

    if (!(await exists(skillMdPath))) {
      console.warn(`No SKILL.md found at ${skillPath}`);
      return null;
    }

    const content = await readTextFile(skillMdPath);
    const { metadata, body } = parseFrontmatter(content);

    if (!metadata) {
      console.warn(`Invalid SKILL.md frontmatter at ${skillPath}`);
      return null;
    }

    return {
      ...metadata,
      instructions: body,
      path: skillPath,
    };
  } catch (error) {
    console.error(`Error loading skill from ${skillPath}:`, error);
    return null;
  }
}

export async function loadSkillsFromVault(vaultPath: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  try {
    const skillsPath = await join(vaultPath, 'skills');

    if (!(await exists(skillsPath))) {
      // Skills directory doesn't exist yet, return empty array
      return skills;
    }

    const entries = await readDir(skillsPath);

    for (const entry of entries) {
      if (entry.isDirectory && entry.name) {
        const skillPath = await join(skillsPath, entry.name);
        const skill = await loadSkillFromPath(skillPath);
        if (skill) {
          skills.push(skill);
        }
      }
    }
  } catch (error) {
    console.error('Error loading skills from vault:', error);
  }

  return skills;
}
