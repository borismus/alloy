import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StreamingProvider, useStreamingContext } from './StreamingContext';

function ToolProbe() {
  const controls = useStreamingContext();
  const tools = controls.getStreamingState('conversation-1')?.streamingToolUse ?? [];
  const count = tools.length;
  const query = tools[0]?.input?.query;
  return (
    <>
      <output aria-label="Tool count">{count}</output>
      <output aria-label="Tool query">{typeof query === 'string' ? query : ''}</output>
      <button onClick={() => controls.startStreaming('conversation-1')}>Start</button>
      <button onClick={() => controls.addToolUse('conversation-1', {
        type: 'read_file',
        input: { path: 'notes/example.md' },
      })}>
        Add tool
      </button>
      <button onClick={() => controls.addToolUse('conversation-1', {
        type: 'web_search',
        input: {},
      }, 'search-1')}>
        Start search
      </button>
      <button onClick={() => controls.addToolUse('conversation-1', {
        type: 'web_search',
        input: { query: 'R1811 connector map' },
      }, 'search-1')}>
        Update search
      </button>
    </>
  );
}

afterEach(cleanup);

it('notifies consumers immediately when a streaming tool call starts', () => {
  render(
    <StreamingProvider>
      <ToolProbe />
    </StreamingProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(screen.getByLabelText('Tool count').textContent).toBe('0');

  fireEvent.click(screen.getByRole('button', { name: 'Add tool' }));

  // Regression: addToolUse used to update the internal map without advancing
  // the context version, so this consumer stayed at zero until another text
  // chunk or completion happened to force a render.
  expect(screen.getByLabelText('Tool count').textContent).toBe('1');
});

it('updates a streaming tool pill by call id without duplicating it', () => {
  render(
    <StreamingProvider>
      <ToolProbe />
    </StreamingProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start search' }));
  expect(screen.getByLabelText('Tool count').textContent).toBe('1');
  expect(screen.getByLabelText('Tool query').textContent).toBe('');

  fireEvent.click(screen.getByRole('button', { name: 'Update search' }));
  expect(screen.getByLabelText('Tool count').textContent).toBe('1');
  expect(screen.getByLabelText('Tool query').textContent).toBe('R1811 connector map');
});
