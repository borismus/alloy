import { createContext, useContext } from 'react';
import type { ProviderLocality } from '../utils/models';

/**
 * Each configured provider and whether it's local, from /api/providers. Decided
 * from config, not discovery: an oMLX host that's asleep is still local.
 */
export const ProviderLocalityContext = createContext<ProviderLocality[]>([]);

export function useProviderLocalities(): ProviderLocality[] {
  return useContext(ProviderLocalityContext);
}
