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

  setVaultPath(_path: string): void {
    // Vault skills are read via HTTP /api/fs/* (even in the Tauri app), which
    // resolves paths relative to the server-owned vault root. Passing the
    // absolute path makes the server double it (root + abs) → empty dir, so
    // vault skills silently fail to load. Use '/' as the join base, matching
    // vaultService.setVaultPath.
    this.vaultPath = '/';
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
    let prompt = '';

    // Current date context. Deliberately DATE-only (not time): the system
    // prompt is the shared prefix of every request in a conversation, so a
    // per-second timestamp here changes the prefix each turn and defeats
    // server-side prompt/KV prefix caching (e.g. oMLX cache hit rate collapses
    // to a few %). A day-stable date keeps the whole prefix reusable while
    // still giving the model temporal context.
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    prompt += `Current date: ${dateStr} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n`;
    prompt += 'Each user message begins with the local time it was sent, in brackets. Use these to tell how much time has passed between messages. Don\'t include such timestamps in your replies.\n\n';

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
      // Spelled out because Codex has its own skill library and a shell: told
      // only to "call use_skill", it hunted for SKILL.md under ~/.agents/skills
      // or declared the skill unavailable without trying. This wording took it
      // from 1 of 3 to 4 of 4 skill loads on gpt-5.6-sol, with no use_skill
      // call on an unrelated question.
      prompt += 'These are Alloy skills, not files on disk and not part of any skill library of your own. ';
      prompt += 'The only way to load one is the `use_skill` tool (it may appear as `alloy.use_skill` or `mcp__alloy__use_skill`). ';
      prompt += 'When a request matches a skill, call `use_skill` with its name and follow the instructions it returns. ';
      prompt += 'Never look for SKILL.md files with a shell or file search, and never conclude a skill is unavailable without calling `use_skill`.\n\n';

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
