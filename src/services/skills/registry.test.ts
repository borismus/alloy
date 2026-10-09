import { describe, expect, it } from 'vitest';
import { SkillRegistry } from './registry';

describe('SkillRegistry.buildSystemPrompt', () => {
  // Regression: Codex owns a shell and a skill library of its own. Told only to
  // "call use_skill", it hunted for SKILL.md under ~/.agents/skills or declared
  // the skill unavailable without trying the tool.
  it('says skills are not files and use_skill is the only way to load them', () => {
    const prompt = new SkillRegistry().buildSystemPrompt();
    expect(prompt).toContain('# Available Skills');
    expect(prompt).toContain('not files on disk');
    expect(prompt).toContain('The only way to load one is the `use_skill` tool');
    expect(prompt).toContain('never conclude a skill is unavailable without calling `use_skill`');
  });

  it('lists the bundled skills by name', () => {
    const prompt = new SkillRegistry().buildSystemPrompt();
    expect(prompt).toContain('**save-memory**');
  });
});
