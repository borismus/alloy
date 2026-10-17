import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlashCommandMenu } from './SlashCommandMenu';

const items = [
  { name: 'summarize', description: 'Summarize the conversation' },
  { name: 'translate', description: '' },
];

describe('SlashCommandMenu', () => {
  afterEach(cleanup);

  it('lists skills as options and marks the active one', () => {
    render(<SlashCommandMenu items={items} activeIndex={1} onSelect={vi.fn()} onHover={vi.fn()} />);
    const options = screen.getAllByRole('option');
    expect(screen.getByRole('listbox', { name: 'Skills' })).toBeTruthy();
    expect(options.map((option) => option.textContent)).toEqual(['/summarizeSummarize the conversation', '/translate']);
    expect(options[1].className).toContain('active');
    expect(options[0].className).not.toContain('active');
  });

  it('selects on click without taking focus from the composer', async () => {
    const onSelect = vi.fn();
    render(
      <>
        <textarea aria-label="Composer" />
        <SlashCommandMenu items={items} activeIndex={0} onSelect={onSelect} onHover={vi.fn()} />
      </>,
    );
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    composer.focus();
    await userEvent.click(screen.getByRole('option', { name: /translate/ }));
    expect(onSelect).toHaveBeenCalledWith(items[1]);
    expect(document.activeElement).toBe(composer);
  });

  it('reports the hovered option', async () => {
    const onHover = vi.fn();
    render(<SlashCommandMenu items={items} activeIndex={0} onSelect={vi.fn()} onHover={onHover} />);
    await userEvent.hover(screen.getByRole('option', { name: /translate/ }));
    expect(onHover).toHaveBeenCalledWith(1);
  });
});
