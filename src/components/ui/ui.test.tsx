import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  DialogTrigger,
  MenuTrigger,
  Button as AriaButton,
} from 'react-aria-components';
import { Button, AlloyDialog, SearchField, SelectField, AlloyMenu } from './index';

afterEach(cleanup);

describe('ui primitives', () => {
  it('renders a Button with its label and variant/size classes', () => {
    render(<Button variant="primary" size="small">Run now</Button>);
    const button = screen.getByRole('button', { name: 'Run now' });
    expect(button).toBeTruthy();
    // Variant + size classes are applied (CSS Modules hash the names).
    expect(button.className.split(' ').length).toBeGreaterThanOrEqual(3);
  });

  it('renders a SearchField with an accessible name and clear button', () => {
    render(<SearchField aria-label="Search your work" placeholder="Search…" />);
    expect(screen.getByRole('searchbox', { name: 'Search your work' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });

  it('renders a SelectField trigger showing the selected option', () => {
    render(
      <SelectField
        label="Title model"
        value="fast"
        options={[
          { id: 'current', label: 'Current conversation model' },
          { id: 'fast', label: 'Fastest available model' },
        ]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Title model')).toBeTruthy();
    // The selected label appears in the trigger's SelectValue (and again in the
    // collection, which stays mounted but hidden), so assert at least one.
    expect(screen.getAllByText('Fastest available model').length).toBeGreaterThan(0);
  });

  it('renders a dialog trigger that is closed until pressed', () => {
    render(
      <DialogTrigger>
        <Button>Open settings</Button>
        <AlloyDialog title="Settings">{() => <p>Body</p>}</AlloyDialog>
      </DialogTrigger>,
    );
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
    // Dialog content is not mounted until the trigger opens it.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a menu trigger that is closed until pressed', () => {
    render(
      <MenuTrigger>
        <AriaButton aria-label="Create new">＋</AriaButton>
        <AlloyMenu
          items={[{ id: 'chat', label: 'New conversation' }]}
          onAction={vi.fn()}
        />
      </MenuTrigger>,
    );
    expect(screen.getByRole('button', { name: 'Create new' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
