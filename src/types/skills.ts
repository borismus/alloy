// Skills types for PromptBox

export interface SkillMetadata {
  name: string;
  description: string;
}

export interface Skill extends SkillMetadata {
  instructions: string;  // markdown body of SKILL.md (after frontmatter)
  path: string;          // path to skill directory
}
