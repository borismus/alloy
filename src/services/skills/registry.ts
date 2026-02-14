import { Skill } from '../../types/skills';
import { loadSkillsFromVault } from './loader';
import { loadBundledSkills } from './bundled';

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private vaultPath: string | null = null;
  private bundledSkills: Skill[];

  constructor() {
    // Load bundled skills from skills/ directory
    this.bundledSkills = loadBundledSkills();
    for (const skill of this.bundledSkills) {
      this.skills.set(skill.name, skill);
    }
  }

  setVaultPath(path: string): void {
    this.vaultPath = path;
  }

  async loadSkills(): Promise<void> {
    // Start with bundled skills
    this.skills.clear();
    for (const skill of this.bundledSkills) {
      this.skills.set(skill.name, skill);
    }

    // Load vault skills (can override bundled skills)
    if (this.vaultPath) {
      const vaultSkills = await loadSkillsFromVault(this.vaultPath);
      for (const skill of vaultSkills) {
        this.skills.set(skill.name, skill);
      }
      console.log(`Loaded ${vaultSkills.length} vault skills + ${this.bundledSkills.length} bundled skills`);
    } else {
      console.log(`Loaded ${this.bundledSkills.length} bundled skills (no vault path set)`);
    }
  }

  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  // Build system prompt with skill summaries (frontmatter only)
  // Full instructions are loaded on-demand when a skill is used via use_skill tool
  buildSystemPrompt(conversationContext?: { id: string; title?: string }, memoryContent?: string): string {
    const skills = this.getSkills();
    console.log('[buildSystemPrompt] skills count:', skills.length, 'names:', skills.map(s => s.name));
    let prompt = '';

    // Current date/time context
    const now = new Date();
    prompt += `Current time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n\n`;

    // Inject memory content at the top if provided
    if (memoryContent) {
      prompt += '# Memory\n\n';
      prompt += memoryContent.trim() + '\n\n';
    }

    // Add conversation context for provenance markers
    if (conversationContext) {
      const slug = conversationContext.title ? this.generateSlug(conversationContext.title) : '';
      const conversationPath = slug
        ? `conversations/${conversationContext.id}-${slug}`
        : `conversations/${conversationContext.id}`;
      prompt += '# Current Conversation\n\n';
      prompt += `This conversation's path is: \`${conversationPath}\`\n`;
      prompt += `When writing notes with provenance markers, use: \`&[[${conversationPath}]]\`\n\n`;
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

  // Helper to generate slug from title (matches vault service)
  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  // Get full instructions for a skill by name
  getSkillInstructions(name: string): string | null {
    const skill = this.skills.get(name);
    return skill ? skill.instructions : null;
  }
}

export const skillRegistry = new SkillRegistry();
