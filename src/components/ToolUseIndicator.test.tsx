import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ToolUseIndicator } from './ToolUseIndicator';

afterEach(cleanup);

it('labels a completed Codex-native command as a tool pill', () => {
  render(
    <ToolUseIndicator
      toolUse={[{
        type: 'command_execution',
        input: { command: '/bin/zsh -lc pwd', cwd: '/tmp' },
        result: '/private/tmp\n',
      }]}
    />,
  );

  expect(screen.getByText('Ran command')).toBeTruthy();
});

it('does not quote an unavailable web query and shows it once supplied', () => {
  const { rerender } = render(
    <ToolUseIndicator
      toolUse={[{ type: 'web_search', input: { query: '' }, result: undefined }]}
      isStreaming
    />,
  );
  expect(screen.getByText('Searching')).toBeTruthy();
  expect(screen.queryByText('Searching ""')).toBeNull();

  rerender(
    <ToolUseIndicator
      toolUse={[{
        type: 'web_search',
        input: { query: 'R1811 connector map' },
        result: 'Found 2 result(s)',
      }]}
    />,
  );
  expect(screen.getByText('Searched "R1811 connector map"')).toBeTruthy();
});
