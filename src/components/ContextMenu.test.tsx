import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextMenuProvider, useContextMenu, type ContextMenuItem } from '../contexts/ContextMenuContext';
import { ContextMenu } from './ContextMenu';

afterEach(cleanup);

function Opener({ items }: { items: ContextMenuItem[] }) {
  const { showMenu } = useContextMenu();
  return <button onClick={() => showMenu(items, 10, 10)}>Open</button>;
}

function renderMenu(items: ContextMenuItem[]) {
  render(
    <ContextMenuProvider>
      <Opener items={items} />
      <ContextMenu />
    </ContextMenuProvider>,
  );
}

it('exposes a menu that the arrow keys walk and Enter activates', async () => {
  const user = userEvent.setup();
  const rename = vi.fn();
  const remove = vi.fn();
  renderMenu([
    { id: 'rename', text: 'Rename', action: rename },
    { id: 'edit', text: 'Open in default app', enabled: false },
    { id: 'delete', text: 'Delete', danger: true, separatorBefore: true, action: remove },
  ]);

  await user.click(screen.getByRole('button', { name: 'Open' }));
  const menu = screen.getByRole('menu');
  expect(document.activeElement).toBe(menu);
  expect(screen.getAllByRole('menuitem').map(i => i.textContent))
    .toEqual(['Rename', 'Open in default app', 'Delete']);

  await user.keyboard('{ArrowDown}');
  expect(document.activeElement?.textContent).toBe('Rename');
  // The disabled item is skipped, and the list wraps.
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement?.textContent).toBe('Delete');
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement?.textContent).toBe('Rename');
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement?.textContent).toBe('Delete');

  await user.keyboard('{Enter}');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(rename).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  // Focus goes back to what opened the menu.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
});

it('still runs an item on click', async () => {
  const user = userEvent.setup();
  const rename = vi.fn();
  renderMenu([{ id: 'rename', text: 'Rename', action: rename }]);

  await user.click(screen.getByRole('button', { name: 'Open' }));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
  expect(rename).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
});
