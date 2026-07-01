import { describe, it, expect } from 'vitest';
import { parseSlashCommand, slashQuery } from './slashCommand';

describe('parseSlashCommand', () => {
  it('parses name + args', () => {
    expect(parseSlashCommand('/research what are the trends')).toEqual({
      name: 'research',
      args: 'what are the trends',
    });
  });

  it('parses a bare command (no args)', () => {
    expect(parseSlashCommand('/research')).toEqual({ name: 'research', args: '' });
    expect(parseSlashCommand('/research   ')).toEqual({ name: 'research', args: '' });
  });

  it('keeps hyphens/underscores in the name', () => {
    expect(parseSlashCommand('/read-url https://x.com')).toEqual({
      name: 'read-url',
      args: 'https://x.com',
    });
  });

  it('returns null for non-commands', () => {
    expect(parseSlashCommand('hello /research')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand(' /research')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('slashQuery', () => {
  it('returns the partial name while typing the command token', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/res')).toBe('res');
    expect(slashQuery('/read-url')).toBe('read-url');
  });

  it('closes (null) once a space or non-slash input appears', () => {
    expect(slashQuery('/research ')).toBeNull();
    expect(slashQuery('/research foo')).toBeNull();
    expect(slashQuery('hello')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });
});
