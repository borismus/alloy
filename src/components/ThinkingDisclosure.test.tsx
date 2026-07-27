import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThinkingDisclosure } from './ThinkingDisclosure';

afterEach(cleanup);

describe('ThinkingDisclosure', () => {
  it('expands to reveal the reasoning when there is a body', async () => {
    const user = userEvent.setup();
    render(
      <ThinkingDisclosure
        thinking="comparing the options"
        startedAt={1000}
        initialElapsedMs={5000}
        durationMs={5000}
        active={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Thought for 5s/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('is not expandable when there is no reasoning body', async () => {
    const user = userEvent.setup();
    render(
      <ThinkingDisclosure
        thinking="   "
        startedAt={1000}
        initialElapsedMs={3000}
        durationMs={3000}
        active={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Thought for 3s/ });
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).not.toBe('true');
  });
});
