import { ModelInfo, ProviderType, ToolUse, SkillUse, getModelIdFromModel } from '../types';

export const PROVIDER_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
  grok: 'Grok',
};

export interface ResponseWithModel {
  content: string;
  model?: string;
  toolUse?: ToolUse[];
  skillUse?: SkillUse[];
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
    const modelString = conversationModels[index];
    const match = availableModels.find((m) => m.key === modelString);
    if (match) return match.name;
    // Return just the model ID part for cleaner display
    return getModelIdFromModel(modelString);
  }

  // Last resort: use availableModels by index
  if (availableModels[index]) {
    return availableModels[index].name;
  }

  return `Model ${index + 1}`;
}

export function getChairmanDisplayName(
  response: ResponseWithModel,
  chairman: ModelInfo | undefined,
  conversationChairman?: string
): string {
  if (chairman) {
    return chairman.name;
  }

  if (response.model) {
    return response.model;
  }

  if (conversationChairman) {
    return conversationChairman;
  }

  return 'Chairman';
}
