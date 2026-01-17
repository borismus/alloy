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

  // Build system prompt with skill summaries (frontmatter only)
  // Full instructions are loaded on-demand when a skill is used via use_skill tool
  buildSystemPrompt(basePrompt?: string): string {
    const skills = this.getSkills();
    console.log('[buildSystemPrompt] skills count:', skills.length, 'names:', skills.map(s => s.name));
    let prompt = '';

    // Add base prompt if provided
    if (basePrompt) {
      prompt += basePrompt + '\n\n';
    }

    // Add skill summaries (name + description only)
    if (skills.length > 0) {
      prompt += '# Available Skills\n\n';
      prompt += 'You have access to the following skills. To use a skill, call the `use_skill` tool with the skill name. ';
      prompt += 'The tool will return detailed instructions that you should follow to complete the task.\n\n';

      for (const skill of skills) {
        prompt += `- **${skill.name}**: ${skill.description}\n`;
      }
      prompt += '\n';
    }

    return prompt;
  }

  // Get full instructions for a skill by name
  getSkillInstructions(name: string): string | null {
    const skill = this.skills.get(name);
    return skill ? skill.instructions : null;
  }
}

export const skillRegistry = new SkillRegistry();
