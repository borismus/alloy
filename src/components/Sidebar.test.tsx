import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function renderSidebar(overrides: {
  onNewConversation?: () => void;
  onNewRiff?: () => void;
  fullScreen?: boolean;
} = {}) {
  return render(
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
        onNewConversation={overrides.onNewConversation ?? vi.fn()}
        onNewRiff={overrides.onNewRiff ?? vi.fn()}
        onRenameConversation={vi.fn()}
        onRenameRiff={vi.fn()}
        onDeleteConversation={vi.fn()}
        onDeleteTask={vi.fn()}
        onDeleteNote={vi.fn()}
        externalEditor="system"
        fullScreen={overrides.fullScreen}
        onMobileBack={overrides.fullScreen ? vi.fn() : undefined}
      />
    </TaskProvider>,
  );
}

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

  renderSidebar();

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

it('creates one conversation directly from the plus button', () => {
  const onNewConversation = vi.fn();
  const onNewRiff = vi.fn();
  renderSidebar({ onNewConversation, onNewRiff });

  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

  expect(onNewConversation).toHaveBeenCalledTimes(1);
  expect(onNewRiff).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('creates one conversation when the plus button is keyboard-activated', async () => {
  vi.useRealTimers();
  const onNewConversation = vi.fn();
  const user = userEvent.setup();
  renderSidebar({ onNewConversation });

  const newConversation = screen.getByRole('button', { name: 'New conversation' });
  newConversation.focus();
  await user.keyboard('{Enter}');

  expect(onNewConversation).toHaveBeenCalledTimes(1);
});

it('keeps new riff available from the creation overflow menu', () => {
  const onNewConversation = vi.fn();
  const onNewRiff = vi.fn();
  renderSidebar({ onNewConversation, onNewRiff });

  fireEvent.click(screen.getByRole('button', { name: 'More creation options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New riff' }));

  expect(onNewRiff).toHaveBeenCalledTimes(1);
  expect(onNewConversation).not.toHaveBeenCalled();
});

it('moves creation actions into the header in mobile full-screen mode', () => {
  renderSidebar({ fullScreen: true });

  const header = screen.getByRole('heading', { name: 'Alloy' }).parentElement;
  const searchRow = screen.getByPlaceholderText('Search...').closest('.search-box');
  const newConversation = screen.getByRole('button', { name: 'New conversation' });
  const creationOverflow = screen.getByRole('button', { name: 'More creation options' });

  expect(header?.contains(newConversation)).toBe(true);
  expect(header?.contains(creationOverflow)).toBe(true);
  expect(searchRow?.contains(newConversation)).toBe(false);
  expect(searchRow?.contains(creationOverflow)).toBe(false);
});
