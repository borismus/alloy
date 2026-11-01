import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../types';
import { NoteViewer } from './NoteViewer';

afterEach(cleanup);

const models = [{ key: 'openrouter/test', name: 'Test', provider: 'openrouter' }] as unknown as ModelInfo[];

function renderViewer(filename: string) {
  render(
    <NoteViewer
      content={'---\nname: flux\n---\nSteps.\n'}
      filename={filename}
      onSaveNote={vi.fn()}
      availableModels={models}
      defaultModel="openrouter/test"
    />,
  );
}

it('asks for a change to the skill when a skill is open', () => {
  renderViewer('skills/flux-highlights/SKILL.md');
  expect(screen.getByPlaceholderText('Ask for a change to this skill…')).toBeTruthy();
  expect(screen.getByText('flux-highlights')).toBeTruthy();
});

it('asks for a change to the note otherwise', () => {
  renderViewer('Idea.md');
  expect(screen.getByPlaceholderText('Ask for a change to this note…')).toBeTruthy();
});
