/**
 * Notes, memory.md and skills share the note viewer and the timeline. A note's
 * id is its filename under notes/; memory.md and skills keep their vault path
 * (`memory.md`, `skills/<folder>/SKILL.md`), which is how they're told apart.
 */

export function isSkillFile(filename: string): boolean {
  return filename.startsWith('skills/');
}

/** The timeline id of a skill folder's SKILL.md. */
export function skillFilename(folder: string): string {
  return `skills/${folder}/SKILL.md`;
}

/** What to call a note-like item: a skill by its folder, a note by its name. */
export function noteDisplayName(filename: string): string {
  const skill = filename.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skill) return skill[1];
  return filename.replace(/^notes\//, '').replace(/\.md$/, '');
}
