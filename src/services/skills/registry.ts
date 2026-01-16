import { Skill } from '../../types/skills';
import { loadSkillsFromVault } from './loader';

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private vaultPath: string | null = null;

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  async loadSkills(): Promise<void> {
    if (!this.vaultPath) {
      console.warn('No vault path set, cannot load skills');
      return;
    }

    const skills = await loadSkillsFromVault(this.vaultPath);
    this.skills.clear();

    for (const skill of skills) {
      this.skills.set(skill.name, skill);
    }

    console.log(`Loaded ${skills.length} skills:`, skills.map(s => s.name));
  }

  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  // Build system prompt with skill descriptions
  buildSystemPrompt(basePrompt?: string): string {
    const skills = this.getSkills();
    let prompt = '';

    // Add base prompt if provided
    if (basePrompt) {
      prompt += basePrompt + '\n\n';
    }

    // Add skill instructions directly (no need for model to read SKILL.md)
    if (skills.length > 0) {
      prompt += '# Skills\n\n';

      for (const skill of skills) {
        prompt += `## ${skill.name}\n\n`;
        prompt += skill.instructions + '\n\n';
      }
    }

    return prompt;
  }
}

export const skillRegistry = new SkillRegistry();
