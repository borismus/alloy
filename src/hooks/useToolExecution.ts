import { useCallback } from 'react';
import { Message } from '../types';
import { IProviderService } from '../services/providers/types';
import { executeWithTools, ToolExecutionOptions, ToolExecutionResult } from '../services/tools/executor';
import { useApproval } from '../contexts/ApprovalContext';

/**
 * Hook that wraps executeWithTools with built-in approval handling.
 * Any component using this hook will automatically get write approval UI support.
 */
export function useToolExecution() {
  const { requestApproval } = useApproval();

  const execute = useCallback(async (
    provider: IProviderService,
    messages: Message[],
    model: string,
    options: Omit<ToolExecutionOptions, 'onApprovalRequired'> = {}
  ): Promise<ToolExecutionResult> => {
    return executeWithTools(provider, messages, model, {
      ...options,
      onApprovalRequired: requestApproval,
    });
  }, [requestApproval]);

  return { execute };
}