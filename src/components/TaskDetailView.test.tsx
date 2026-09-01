import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskProvider } from '../contexts/TaskContext';
import type { ScheduledTask } from '../types';
import { TaskDetailView } from './TaskDetailView';

const task: ScheduledTask = {
  id: 'task-1',
  created: '2026-08-01T08:00:00Z',
  updated: '2026-08-02T08:00:00Z',
  title: 'Morning report',
  model: 'mlx-local/Qwen',
  enabled: true,
  email: true,
  prompt: 'Prepare the report',
  schedule: { cron: '0 8 * * *', timezone: 'UTC' },
  lastRunAt: '2026-08-02T08:00:00Z',
  lastDeliveredAt: '2026-08-01T08:00:00Z',
  history: [
    {
      timestamp: '2026-08-02T08:00:00Z',
      result: 'error',
      reasoning: '',
      runner: 'smusmini',
      error: 'Model host is offline',
    },
    {
      timestamp: '2026-08-01T08:00:00Z',
      result: 'completed',
      reasoning: 'Yesterday report',
      runner: 'smusmini',
      usage: { inputTokens: 10, outputTokens: 20, connectionRetries: 1 },
    },
  ],
  messages: [
    {
      role: 'assistant',
      timestamp: '2026-08-01T08:00:00Z',
      content: 'Yesterday report',
    },
  ],
};

afterEach(cleanup);

describe('TaskDetailView failure state', () => {
  it('shows the latest error prominently and expands it ahead of an older delivery', () => {
    render(
      <TaskProvider tasks={[task]}>
        <TaskDetailView
          task={task}
          availableModels={[]}
          onDelete={vi.fn()}
          onRunComplete={vi.fn()}
          onAskAbout={vi.fn()}
          onTaskUpdated={vi.fn()}
        />
      </TaskProvider>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Latest run failed');
    expect(alert.textContent).toContain('Model host is offline');

    const failedBadge = screen.getByText('Error', { selector: '.history-result' });
    expect(failedBadge.closest('button')?.getAttribute('aria-expanded')).toBe('true');
    const completedBadge = screen.getByText('Completed', { selector: '.history-result' });
    expect(completedBadge.closest('button')?.getAttribute('aria-expanded')).toBe('false');

    expect(screen.getAllByText('Runner: smusmini')).toHaveLength(2);
    expect(screen.getByText('Recovered after 1 connection retry')).toBeTruthy();
    expect(screen.getByTitle('Delivered results and first-failure alerts are emailed via Resend'))
      .toBeTruthy();
  });
});
