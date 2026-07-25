import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelector } from './ModelSelector';
import type { ModelInfo } from '../types';

const models: ModelInfo[] = [
  { key: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic' },
  { key: 'openrouter/anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'openrouter' },
  { key: 'mlx/qwen3.6-27b', name: 'Qwen 3.6 27B', provider: 'mlx', local: true },
];

function Harness({ onChange, onToggle }: { onChange: (k: string) => void; onToggle: (k: string) => void }) {
  const [favorites, setFavorites] = useState<string[]>([]);
  const [value, setValue] = useState('anthropic/claude-opus-4-6');
  return (
    <ModelSelector
      value={value}
      onChange={(k) => { onChange(k); setValue(k); }}
      disabled={false}
      models={models}
      favoriteModels={favorites}
      onToggleFavorite={(k) => {
        onToggle(k);
        setFavorites((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));
      }}
    />
  );
}

afterEach(cleanup);

describe('ModelSelector interaction', () => {
  it('opens the popover and shows the search field', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} onToggle={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('searchbox', { name: 'Search models' })).toBeTruthy();
  });

  it('toggles favorite when the star is clicked, without selecting the model', async () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} onToggle={onToggle} />);
    await user.click(screen.getByRole('button', { name: /^Model:/ }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'haiku');
    const star = await screen.findByRole('button', { name: 'Add to favorites' });
    await user.click(star);
    expect(onToggle).toHaveBeenCalledWith('openrouter/anthropic/claude-haiku-4.5');
    expect(onChange).not.toHaveBeenCalled();
    // Star flips to "remove" and the popover stays open.
    expect(await screen.findByRole('button', { name: 'Remove from favorites' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search models' })).toBeTruthy();
  });

  it('selects a model and closes when a row is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} onToggle={vi.fn()} />);
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
});
