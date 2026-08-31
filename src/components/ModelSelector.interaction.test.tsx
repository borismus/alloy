import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelector } from './ModelSelector';
import { setDefaultPreference, toggleFavoritePreference, type ModelPreferences } from '../utils/modelPreferences';
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
  onToggle = vi.fn(),
  onSetDefault = vi.fn(),
  initialValue = 'anthropic/claude-opus-4-6',
  initialPreferences = {
    defaultModel: 'anthropic/claude-opus-4-6',
    favoriteModels: ['openrouter/anthropic/claude-haiku-4.5'],
  },
}: {
  onChange: (key: string) => void;
  onToggle?: (key: string) => void;
  onSetDefault?: (key: string) => void;
  initialValue?: string;
  initialPreferences?: ModelPreferences;
}) {
  const [preferences, setPreferences] = useState<ModelPreferences>(initialPreferences);
  const [value, setValue] = useState(initialValue);
  return (
    <ModelSelector
      value={value}
      onChange={(key) => { onChange(key); setValue(key); }}
      disabled={false}
      models={models}
      favoriteModels={preferences.favoriteModels}
      defaultModel={preferences.defaultModel}
      onToggleFavorite={(key) => {
        onToggle(key);
        setPreferences((current) => toggleFavoritePreference(current, key));
      }}
      onSetDefault={(key) => {
        onSetDefault(key);
        setPreferences((current) => setDefaultPreference(current, key));
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

  it('shows the default first with a fixed marker instead of a favorite button', async () => {
    const user = userEvent.setup();
    render(<Harness
      onChange={vi.fn()}
      initialPreferences={{
        defaultModel: 'codex-cli/gpt-5.6-sol',
        // A default can remain independently present in config favorites, but
        // the picker still exposes only its fixed default status.
        favoriteModels: ['anthropic/claude-opus-4-6', 'codex-cli/gpt-5.6-sol'],
      }}
    />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));

    const options = await screen.findAllByRole('option');
    expect(options[0].textContent).toContain('GPT-5.6-Sol');
    expect(options[0].getAttribute('data-default')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Default model' })).toBeTruthy();
    expect(options[0].querySelector('[role="button"]')).toBeNull();
  });

  it('toggles a model directly between non-favorite and favorite', async () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} onToggle={onToggle} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'qwen 3.6');

    const hollow = await screen.findByRole('button', { name: 'Add Qwen 3.6 27B to favorites' });
    expect(hollow.getAttribute('data-favorite')).toBe('false');
    await user.click(hollow);
    expect(onToggle).toHaveBeenCalledWith('mlx/qwen3.6-27b');
    expect(onChange).not.toHaveBeenCalled();

    const favorite = await screen.findByRole('button', { name: 'Remove Qwen 3.6 27B from favorites' });
    expect(favorite.getAttribute('data-favorite')).toBe('true');
    await user.click(favorite);
    expect(await screen.findByRole('button', { name: 'Add Qwen 3.6 27B to favorites' })).toBeTruthy();
  });

  it('sets the default from a separate row action without selecting or favoriting it', async () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    const onSetDefault = vi.fn();
    const user = userEvent.setup();
    render(<Harness
      onChange={onChange}
      onToggle={onToggle}
      onSetDefault={onSetDefault}
    />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'qwen 3.6');

    await user.click(await screen.findByRole('button', { name: 'Set Qwen 3.6 27B as default' }));
    expect(onSetDefault).toHaveBeenCalledWith('mlx/qwen3.6-27b');
    expect(onToggle).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    const defaultRow = await screen.findByRole('option', { name: /Qwen 3.6 27B/ });
    expect(defaultRow.getAttribute('data-default')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Default model' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Qwen 3.6 27B.*favorites/i })).toBeNull();
  });

  it('keeps an unstarred row for the current picker session, then removes it', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));

    await user.click(await screen.findByRole('button', { name: 'Remove Claude Haiku 4.5 from favorites' }));
    expect(screen.getByRole('option', { name: /Claude Haiku 4.5/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Claude Haiku 4.5 to favorites' })).toBeTruthy();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    await screen.findByRole('img', { name: 'Default model' });
    expect(screen.queryByRole('option', { name: /Claude Haiku 4.5/ })).toBeNull();
  });

  it('does not re-pin an unstarred selected model while a default remains', async () => {
    const user = userEvent.setup();
    render(<Harness
      onChange={vi.fn()}
      initialValue="openrouter/anthropic/claude-haiku-4.5"
    />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove Claude Haiku 4.5 from favorites' }));

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    await screen.findByRole('option', { name: /Claude Opus 4.6/ });
    expect(screen.queryByRole('option', { name: /Claude Haiku 4.5/ })).toBeNull();
  });

  it('pins the selected model when no default or favorites are configured', async () => {
    const user = userEvent.setup();
    render(<Harness
      onChange={vi.fn()}
      initialPreferences={{ defaultModel: '', favoriteModels: [] }}
    />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('option', { name: /Claude Opus 4.6/ })).toBeTruthy();
  });

  it('toggles a favorite from the keyboard without selecting the row', async () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} onToggle={onToggle} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'qwen');
    const star = await screen.findByRole('button', { name: 'Add Qwen 3.6 27B to favorites' });
    fireEvent.keyDown(star, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledWith('mlx/qwen3.6-27b');
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Remove Qwen 3.6 27B from favorites' })).toBeTruthy();
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
    expect(screen.queryByRole('searchbox', { name: 'Search models' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Model: Qwen 3.6 27B' })).toBeTruthy();
  });

  it('closes when the already-selected model is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Model: Claude Opus 4.6' }));
    await user.click(await screen.findByRole('option', { name: /Claude Opus 4.6/ }));
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-opus-4-6');
    expect(screen.queryByRole('searchbox', { name: 'Search models' })).toBeNull();
  });
});
