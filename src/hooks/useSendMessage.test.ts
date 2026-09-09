import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillRegistry } from '../services/skills';
import { ServerStreamError } from '../services/server-streaming';
import { vaultService } from '../services/vault';
import type { Config, Conversation } from '../types';
import { useSendMessage } from './useSendMessage';

const serverMock = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('../services/server-streaming', async () => {
  const actual = await vi.importActual<typeof import('../services/server-streaming')>(
    '../services/server-streaming',
  );
  return { ...actual, executeViaServer: serverMock.execute };
});

afterEach(() => {
  vi.restoreAllMocks();
  serverMock.execute.mockReset();
});

describe('useSendMessage server-owned errors', () => {
  it('does not overwrite an atomically persisted assistant error', async () => {
    const conversation: Conversation = {
      id: 'conv-error',
      model: 'mlx/test',
      created: '2024-01-01T10:00:00Z',
      updated: '2024-01-01T10:00:00Z',
      messages: [],
      messagesLoaded: true,
    };
    const persisted: Conversation = {
      ...conversation,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          timestamp: '2024-01-01T10:01:00Z',
          content: 'research this',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: '2024-01-01T10:02:00Z',
          content: '',
          error: 'model returned no final text',
          toolUse: [{ type: 'search_directory', result: 'no cost basis found' }],
        },
      ],
    };

    vi.spyOn(vaultService, 'getVaultPath').mockReturnValue(null);
    const save = vi.spyOn(vaultService, 'saveConversation').mockResolvedValue();
    let assistantMessageId = '';
    vi.spyOn(vaultService, 'loadConversation').mockImplementation(async () => ({
      ...persisted,
      messages: persisted.messages.map(message =>
        message.role === 'assistant' ? { ...message, id: assistantMessageId } : message
      ),
    }));
    vi.spyOn(skillRegistry, 'buildSystemPrompt').mockReturnValue('system');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    serverMock.execute.mockImplementation(async (_conversationId, messageId) => {
      assistantMessageId = messageId;
      throw new ServerStreamError('model returned no final text', true);
    });

    const setDraftConversation = vi.fn();
    const setConversations = vi.fn();
    const { result } = renderHook(() => useSendMessage({
      config: {} as Config,
      memory: null,
      markSelfWrite: vi.fn(),
      showToast: vi.fn(),
      chatInterfaceRef: { current: { focusInput: vi.fn(), setInputText: vi.fn() } },
      setDraftConversation,
      setConversations,
      setStreamingThinkingState: vi.fn(),
      updateStreamingThinking: vi.fn(),
      finishStreamingThinking: vi.fn(),
      addToolUse: vi.fn(),
      startSubagents: vi.fn(),
      updateSubagentContent: vi.fn(),
      addSubagentToolUse: vi.fn(),
      completeSubagent: vi.fn(),
    }));

    await act(async () => {
      await result.current.handleSendMessage(conversation, 'research this', []);
    });

    // The initial user-message save remains client-owned. There must be no
    // second save after SSE reports a backend-persisted error.
    expect(save).toHaveBeenCalledTimes(1);
    expect(vaultService.loadConversation).toHaveBeenCalledWith('conv-error');
    expect(setDraftConversation).toHaveBeenLastCalledWith(expect.any(Function));
    expect(setConversations).toHaveBeenLastCalledWith(expect.any(Function));
    const applyDraftUpdate = setDraftConversation.mock.lastCall?.[0];
    const displayed = applyDraftUpdate(persisted);
    expect(displayed.messages.at(-1)).toMatchObject({
      id: assistantMessageId,
      error: 'model returned no final text',
      toolUse: [{ type: 'search_directory' }],
    });
  });
});
