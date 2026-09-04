import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskProvider } from '../contexts/TaskContext';
import type { ModelInfo, ScheduledTask } from '../types';
import { TaskDetailView } from './TaskDetailView';

const vaultMock = vi.hoisted(() => ({ updateTask: vi.fn() }));
vi.mock('../services/vault', () => ({
  vaultService: { updateTask: vaultMock.updateTask },
}));

const models: ModelInfo[] = [
  { key: 'mlx-local/Qwen', name: 'Qwen 3.6 27B', provider: 'mlx-local', local: true },
  { key: 'openrouter/openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openrouter' },
];

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

beforeEach(() => {
  vaultMock.updateTask.mockReset();
  vaultMock.updateTask.mockImplementation(async (
    _id: string,
    update: (fresh: ScheduledTask) => ScheduledTask,
  ) => update({ ...task }));
});

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

describe('TaskDetailView configuration controls', () => {
  it('changes the task model through the shared searchable picker', async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    render(
      <TaskProvider tasks={[task]}>
        <TaskDetailView
          task={task}
          availableModels={models}
          favoriteModels={['openrouter/openai/gpt-5.4-mini']}
          defaultModel="mlx-local/Qwen"
          onDelete={vi.fn()}
          onRunComplete={vi.fn()}
          onAskAbout={vi.fn()}
          onTaskUpdated={onTaskUpdated}
        />
      </TaskProvider>,
    );

    const modelRow = screen.getByText('Model', { selector: '.task-field-label' }).closest('.task-model-row');
    expect(modelRow).not.toBeNull();
    await user.click(within(modelRow as HTMLElement).getByRole('button', { name: 'Model: Qwen 3.6 27B' }));
    const search = await screen.findByRole('searchbox', { name: 'Search models' });
    await user.type(search, 'GPT-5.4 Mini');
    await user.click(await screen.findByRole('option', { name: /GPT-5.4 Mini/ }));

    await waitFor(() => expect(onTaskUpdated).toHaveBeenCalledTimes(1));
    expect(vaultMock.updateTask).toHaveBeenCalledWith(task.id, expect.any(Function));
    const updated = onTaskUpdated.mock.calls[0][0] as ScheduledTask;
    expect(updated.model).toBe('openrouter/openai/gpt-5.4-mini');
    expect(updated.email).toBe(true);
    expect(updated.history).toEqual(task.history);
    expect(updated.updated).not.toBe(task.updated);
  });

  it('toggles task email delivery without changing the rest of its config', async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    render(
      <TaskProvider tasks={[task]}>
        <TaskDetailView
          task={task}
          availableModels={models}
          onDelete={vi.fn()}
          onRunComplete={vi.fn()}
          onAskAbout={vi.fn()}
          onTaskUpdated={onTaskUpdated}
        />
      </TaskProvider>,
    );

    const emailSwitch = screen.getByRole('switch', { name: 'Email task results' });
    expect((emailSwitch as HTMLInputElement).checked).toBe(true);
    await user.click(emailSwitch);

    await waitFor(() => expect(onTaskUpdated).toHaveBeenCalledTimes(1));
    const updated = onTaskUpdated.mock.calls[0][0] as ScheduledTask;
    expect(updated.email).toBe(false);
    expect(updated.model).toBe(task.model);
    expect(updated.schedule).toEqual(task.schedule);
    expect(updated.history).toEqual(task.history);
  });
});
