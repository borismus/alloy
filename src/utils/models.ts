import { ModelInfo } from '../types';

interface ResponseWithModel {
  content: string;
  model?: string;
}

export function getModelDisplayName(
  response: ResponseWithModel,
  index: number,
  availableModels: ModelInfo[],
  conversationModels?: string[]
): string {
  // Try to find model by response.model field
  if (response.model) {
    const match = availableModels.find(
      (m) => m.key === response.model || m.name === response.model
    );
    if (match) return match.name;
    return response.model;
  }

  // Fall back to positional matching with conversation models
  if (conversationModels && conversationModels[index]) {
    const modelId = conversationModels[index];
    const match = availableModels.find((m) => m.key === modelId);
    if (match) return match.name;
    return modelId;
  }

  return `Model ${index + 1}`;
}
