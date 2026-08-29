import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelector } from './ModelSelector';
import { cycleModelPreference, type ModelPreferences } from '../utils/modelPreferences';
import type { ModelInfo } from '../types';

const models: ModelInfo[] = [
  { key: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic' },
  { key: 'openrouter/anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'openrouter' },
  { key: 'mlx/qwen3.6-27b', name: 'Qwen 3.6 27B', provider: 'mlx', local: true },
  { key: 'mlx-local/qwen3.5-9b', name: 'Qwen3.5 9B', provider: 'mlx-local', local: true },
  { key: 'codex-cli/gpt-5.6-sol', name: 'GPT-5.6-Sol', provider: 'codex-cli' },
];

function Harness({
  onChange,
  onCycle = vi.fn(),
  initialPreferences = {
    defaultModel: 'anthropic/claude-opus-4-6',
    favoriteModels: ['anthropic/claude-opus-4-6'],
  },
}: {
  onChange: (k: string) => void;
  onCycle?: (k: string) => void;
  initialPreferences?: ModelPreferences;
}) {
  // Mirror App: the picker reports star activations; the parent advances the
  // state machine (utils/modelPreferences) and persists.
  const [preferences, setPreferences] = useState<ModelPreferences>(initialPreferences);
  const [value, setValue] = useState('anthropic/claude-opus-4-6');
  return (
    <ModelSelector
      value={value}
      onChange={(k) => { onChange(k); setValue(k); }}
      disabled={false}
      models={models}
      favoriteModels={preferences.favoriteModels}
      defaultModel={preferences.defaultModel}
      onCycleModelPreference={(k) => {
        onCycle(k);
        setPreferences((current) => cycleModelPreference(current, k));
      }}
    />
  );
}

afterEach(cleanup);

describe('ModelSelector interaction', () => {
  it('opens the popover and shows the search field', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('searchbox', { name: 'Search models' })).toBeTruthy();
  });

  it('cycles the star hollow → yellow → red → hollow and updates cached rows', async () => {
    const onChange = vi.fn();
    const onCycle = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} onCycle={onCycle} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));

    expect((await screen.findByRole('button', { name: 'Remove Claude Opus 4.6 as default' }))
      .getAttribute('data-preference')).toBe('default');
    const search = screen.getByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'haiku');

    // hollow → yellow favorite
    const hollow = await screen.findByRole('button', { name: 'Add Claude Haiku 4.5 to favorites' });
    expect(hollow.getAttribute('data-preference')).toBe('none');
    await user.click(hollow);
    expect(onCycle).toHaveBeenCalledWith('openrouter/anthropic/claude-haiku-4.5');
    expect(onChange).not.toHaveBeenCalled();

    // yellow → red default (and the old default demotes to yellow)
    const favorite = await screen.findByRole('button', { name: 'Make Claude Haiku 4.5 the default model' });
    expect(favorite.getAttribute('data-preference')).toBe('favorite');
    await user.click(favorite);
    const promoted = await screen.findByRole('button', { name: 'Remove Claude Haiku 4.5 as default' });
    expect(promoted.getAttribute('data-preference')).toBe('default');

    // red → hollow (unsets the default entirely)
    await user.click(promoted);
    expect((await screen.findByRole('button', { name: 'Add Claude Haiku 4.5 to favorites' }))
      .getAttribute('data-preference')).toBe('none');

    await user.clear(search);
    expect((await screen.findByRole('button', { name: 'Make Claude Opus 4.6 the default model' }))
      .getAttribute('data-preference')).toBe('favorite');
  });

  it('keeps a row in the pinned list while cycling, instead of yanking it out', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));

    // Opus is the pinned default. Cycle it red → hollow: the row must remain
    // visible (restyled hollow) for the rest of this popover session.
    const star = await screen.findByRole('button', { name: 'Remove Claude Opus 4.6 as default' });
    await user.click(star);
    expect(screen.getByRole('option', { name: /Claude Opus 4.6/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Claude Opus 4.6 to favorites' })
      .getAttribute('data-preference')).toBe('none');

    // Cycle it back up: hollow → yellow → red, all in place.
    await user.click(screen.getByRole('button', { name: 'Add Claude Opus 4.6 to favorites' }));
    await user.click(screen.getByRole('button', { name: 'Make Claude Opus 4.6 the default model' }));
    expect(screen.getByRole('button', { name: 'Remove Claude Opus 4.6 as default' })
      .getAttribute('data-preference')).toBe('default');

    // A fresh popover session re-pins from actual preferences only.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    expect((await screen.findByRole('button', { name: 'Remove Claude Opus 4.6 as default' }))
      .getAttribute('data-preference')).toBe('default');
  });

  it('drops an unstarred model on the next open instead of pinning it as selected', async () => {
    const user = userEvent.setup();
    render(<Harness
      onChange={vi.fn()}
      initialPreferences={{
        defaultModel: '',
        // The selected model (Opus) is a favorite alongside another one.
        favoriteModels: ['anthropic/claude-opus-4-6', 'openrouter/anthropic/claude-haiku-4.5'],
      }}
    />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));

    // Unstar the SELECTED model: yellow → red → hollow. It stays this session.
    await user.click(await screen.findByRole('button', { name: 'Make Claude Opus 4.6 the default model' }));
    await user.click(screen.getByRole('button', { name: 'Remove Claude Opus 4.6 as default' }));
    expect(screen.getByRole('option', { name: /Claude Opus 4.6/ })).toBeTruthy();

    // Reopen: another favorite remains, so the unstarred selected model is gone.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    await screen.findByRole('option', { name: /Claude Haiku 4.5/ });
    expect(screen.queryByRole('option', { name: /Claude Opus 4.6/ })).toBeNull();
  });

  it('still pins the selected model when nothing at all is starred', async () => {
    const user = userEvent.setup();
    render(<Harness
      onChange={vi.fn()}
      initialPreferences={{ defaultModel: '', favoriteModels: [] }}
    />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('option', { name: /Claude Opus 4.6/ })).toBeTruthy();
  });

  it('cycles from the keyboard without selecting the row', async () => {
    const onChange = vi.fn();
    const onCycle = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} onCycle={onCycle} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'qwen');
    const star = await screen.findByRole('button', { name: 'Add Qwen 3.6 27B to favorites' });
    fireEvent.keyDown(star, { key: 'Enter' });
    expect(onCycle).toHaveBeenCalledWith('mlx/qwen3.6-27b');
    expect(onChange).not.toHaveBeenCalled();
    const favorite = await screen.findByRole('button', { name: 'Make Qwen 3.6 27B the default model' });
    fireEvent.keyDown(favorite, { key: 'Enter' });
    expect((await screen.findByRole('button', { name: 'Remove Qwen 3.6 27B as default' }))
      .getAttribute('data-preference')).toBe('default');
  });

  it('finds models by provider name', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'openai');
    expect(await screen.findByRole('option', { name: /GPT-5.6-Sol/ })).toBeTruthy();
  });

  it('finds custom oMLX providers when searching "omlx"', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'omlx');
    // Both the bundled `mlx` id and a user-defined `mlx-local` id must match.
    expect(await screen.findByRole('option', { name: /Qwen 3.6 27B/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Qwen3.5 9B/ })).toBeTruthy();
  });

  it('selects a model and closes when a row is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'qwen');
    await user.click(await screen.findByRole('option', { name: /Qwen 3.6 27B/ }));
    expect(onChange).toHaveBeenCalledWith('mlx/qwen3.6-27b');
    // Popover closes on selection.
    expect(screen.queryByRole('searchbox', { name: 'Search models' })).toBeNull();
    // Trigger reflects the new selection.
    expect(screen.getByRole('button', { name: 'Model: Qwen 3.6 27B' })).toBeTruthy();
  });

  it('closes when the already-selected model is clicked (re-selection is not a no-op)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Model: Claude Opus 4.6' }));
    // With an empty search the selected model is pinned in the list.
    await user.click(await screen.findByRole('option', { name: /Claude Opus 4.6/ }));
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-opus-4-6');
    expect(screen.queryByRole('searchbox', { name: 'Search models' })).toBeNull();
  });
});
