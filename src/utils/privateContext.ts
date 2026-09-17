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
 * Whether switching a conversation to `toModel` would hand private material to a
 * provider that has not already received it.
 *
 * The conversation's history — including tool results read from `private/`
 * mounts — is replayed to whichever model runs the next turn, so the switch
 * itself is the disclosure.
 *
 * Keyed on the destination and the change of provider, not on the origin being
 * local. Two reasons. Model discovery can fail, and an origin we cannot classify
 * would otherwise silently suppress the warning in exactly the situation we know
 * least about. And moving from one cloud provider to another is a disclosure to
 * a new company, even though the material has left the machine before.
 *
 * Staying within one provider does not warn, so switching models to finish a
 * thought stays quiet: a warning that fires when nothing is at stake is one
 * people learn to click through.
 */
export function shouldWarnBeforeModelSwitch(
  conversation: Pick<Conversation, 'private' | 'model'> | null | undefined,
  toModel: string,
  models: ModelInfo[],
): boolean {
  if (!conversation?.private) return false;
  if (toModel === conversation.model) return false;
  if (modelIsLocal(models, toModel)) return false;
  return providerOf(models, toModel) !== providerOf(models, conversation.model);
}
