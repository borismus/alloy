import { expect, it } from 'vitest';
import { isSkillFile, noteDisplayName, skillFilename } from './noteNames';

it('names skills by folder and notes by filename', () => {
  expect(noteDisplayName(skillFilename('flux-highlights'))).toBe('flux-highlights');
  expect(noteDisplayName('Investment strategy.md')).toBe('Investment strategy');
  expect(noteDisplayName('notes/Idea.md')).toBe('Idea');
  expect(noteDisplayName('memory.md')).toBe('memory');
});

it('tells skills from notes, including a note about skills', () => {
  expect(isSkillFile('skills/flux/SKILL.md')).toBe(true);
  expect(isSkillFile('skills/idea.md')).toBe(true);
  expect(isSkillFile('Skills I want.md')).toBe(false);
  expect(isSkillFile('memory.md')).toBe(false);
});
