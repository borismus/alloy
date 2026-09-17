import type { Conversation, ModelInfo } from '../types';

/**
 * Whether a model runs on trusted local hardware.
 *
 * Unknown models count as cloud. A model missing from the catalog is usually one
 * whose provider failed discovery, and guessing "local" there would suppress the
 * warning in exactly the case we know least about.
 */
export function modelIsLocal(models: ModelInfo[], modelKey: string): boolean {
  return models.find(m => m.key === modelKey)?.local === true;
}

/** Provider portion of a `provider/model` key, for naming who receives the data. */
export function providerOf(models: ModelInfo[], modelKey: string): string {
  const known = models.find(m => m.key === modelKey)?.provider;
  return known || modelKey.split('/')[0] || modelKey;
}

/**
 * Why a switch to `toModel` would disclose something, or `null` if it wouldn't.
 *
 * The conversation's history is replayed to whichever model runs the next turn,
 * so the switch itself is the disclosure. Two situations qualify:
 *
 * - `local-origin`: the conversation has been running on a local model. Choosing
 *   one is a privacy decision, and everything typed into it was typed on the
 *   understanding that it stays on the machine — the user's own words, not just
 *   whatever a tool read. This is the common case and the one people expect.
 * - `private-material`: the conversation holds notes read from a `private/`
 *   mount, which matters even when it has already been on a cloud model, because
 *   a second provider is a second recipient.
 *
 * Nothing warns when the destination is local, or within one provider, so a
 * warning keeps meaning something.
 */
export type DisclosureReason = 'local-origin' | 'unknown-origin' | 'private-material';

export function modelSwitchDisclosure(
  conversation: Pick<Conversation, 'private' | 'model'> | null | undefined,
  toModel: string,
  models: ModelInfo[],
): DisclosureReason | null {
  if (!conversation) return null;
  if (toModel === conversation.model) return null;
  if (modelIsLocal(models, toModel)) return null;
  if (modelIsLocal(models, conversation.model)) return 'local-origin';
  // An origin missing from the catalog cannot be cleared. Discovery fails
  // whenever a local endpoint is asleep or unauthorized, and that is precisely
  // when a conversation is most likely to have been local — staying silent here
  // would disarm the warning exactly when it matters.
  if (!models.some(m => m.key === conversation.model)) return 'unknown-origin';
  if (conversation.private && providerOf(models, toModel) !== providerOf(models, conversation.model)) {
    return 'private-material';
  }
  return null;
}

export function shouldWarnBeforeModelSwitch(
  conversation: Pick<Conversation, 'private' | 'model'> | null | undefined,
  toModel: string,
  models: ModelInfo[],
): boolean {
  return modelSwitchDisclosure(conversation, toModel, models) !== null;
}
