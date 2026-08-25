import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskProvider } from '../contexts/TaskContext';
import type { TimelineItem } from '../types';
import { Sidebar } from './Sidebar';

const ITEM: TimelineItem = {
  type: 'conversation',
  id: 'conversation-1',
  title: 'A searchable conversation',
  lastUpdated: new Date('2024-01-10T12:00:00Z').getTime(),
  conversation: {
    id: 'conversation-1',
    created: '2024-01-10T12:00:00Z',
    updated: '2024-01-10T12:00:00Z',
    model: 'openrouter/test-model',
    title: 'A searchable conversation',
    messages: [],
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('does not rerender timeline rows for each search-field keystroke', () => {
  const formatDate = vi
    .spyOn(Date.prototype, 'toLocaleDateString')
    .mockReturnValue('Jan 10');

  render(
    <TaskProvider tasks={[]}>
      <Sidebar
        timelineItems={[ITEM]}
        activeFilter="all"
        onFilterChange={vi.fn()}
        selectedItemId={null}
        onSelectItem={vi.fn()}
        streamingConversationIds={[]}
        unreadConversationIds={[]}
        availableModels={[]}
        onNewConversation={vi.fn()}
        onNewRiff={vi.fn()}
        onRenameConversation={vi.fn()}
        onRenameRiff={vi.fn()}
        onDeleteConversation={vi.fn()}
        onDeleteTask={vi.fn()}
        onDeleteNote={vi.fn()}
        externalEditor="system"
      />
    </TaskProvider>,
  );

  expect(formatDate).toHaveBeenCalled();
  formatDate.mockClear();

  fireEvent.change(screen.getByPlaceholderText('Search...'), {
    target: { value: 'a' },
  });

  // The controlled input updates immediately, but its live value is isolated
  // from the expensive timeline until the existing debounce expires.
  expect((screen.getByPlaceholderText('Search...') as HTMLInputElement).value).toBe('a');
  expect(formatDate).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(200));
  expect(formatDate).toHaveBeenCalled();
});
