import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastContainer } from './Toast';

afterEach(cleanup);

it('dismisses a toast from its Dismiss button', async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn();
  render(<ToastContainer messages={[{ id: 't1', message: 'Saved', type: 'error' }]} onDismiss={onDismiss} />);

  expect(screen.getByText('Saved').closest('.toast')?.classList.contains('toast-error')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledWith('t1');
});
