import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiagramBlock } from './DiagramBlock';

afterEach(cleanup);

it('switches between source and rendered views', async () => {
  const code = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  render(<DiagramBlock kind="svg" code={code} />);
  expect(screen.getByText(code)).toBeTruthy();
  expect(screen.queryByAltText('SVG diagram')).toBeNull();

  await userEvent.click(screen.getByRole('radio', { name: 'Render' }));
  expect(screen.getByAltText('SVG diagram')).toBeTruthy();

  await userEvent.click(screen.getByRole('radio', { name: 'Code' }));
  expect(screen.getByText(code)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Download SVG' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});
