import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedControl } from './SegmentedControl';

const options = [
  { id: 'all', label: 'All' },
  { id: 'conversations', label: 'Chats' },
  { id: 'notes', label: 'Notes' },
];

afterEach(cleanup);

describe('SegmentedControl', () => {
  it('marks the selected segment pressed and changes on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SegmentedControl aria-label="Filter" value="all" options={options} onChange={onChange} />);
    const all = screen.getByRole('radio', { name: 'All' });
    expect(all.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Notes' }));
    expect(onChange).toHaveBeenCalledWith('notes');
  });
});
