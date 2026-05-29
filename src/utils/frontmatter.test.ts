import { describe, it, expect } from 'vitest';
import { parseFrontmatter, splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('splits frontmatter and body, preserving the raw block verbatim', () => {
    const content = '---\ntitle: Hello\ntags:\n  - a\n  - b\n---\nBody line 1\nBody line 2\n';
    const { rawFrontmatter, body } = splitFrontmatter(content);
    expect(rawFrontmatter).toBe('---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n');
    expect(body).toBe('Body line 1\nBody line 2\n');
  });

  it('round-trips: rawFrontmatter + body === original', () => {
    const content = '---\ninteg rated: true\nkey: "weird: value"\n---\nSome **markdown** body\n';
    const { rawFrontmatter, body } = splitFrontmatter(content);
    expect(rawFrontmatter + body).toBe(content);
  });

  it('returns empty frontmatter for content without a frontmatter block', () => {
    const content = '# Just a plain note\n\nNo frontmatter here.';
    const { rawFrontmatter, body } = splitFrontmatter(content);
    expect(rawFrontmatter).toBe('');
    expect(body).toBe(content);
    expect(rawFrontmatter + body).toBe(content);
  });

  it('agrees with parseFrontmatter on the body boundary', () => {
    const content = '---\na: 1\n---\nbody text\n';
    expect(splitFrontmatter(content).body).toBe(parseFrontmatter(content).body);
  });

  it('handles an empty body after frontmatter', () => {
    const content = '---\na: 1\n---\n';
    const { rawFrontmatter, body } = splitFrontmatter(content);
    expect(rawFrontmatter).toBe('---\na: 1\n---\n');
    expect(body).toBe('');
    expect(rawFrontmatter + body).toBe(content);
  });
});
