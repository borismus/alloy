import { useIsMobile } from '../hooks/useIsMobile';

/**
 * Returns textarea props that disable autoCorrect/autoCapitalize/spellCheck
 * on desktop but enable them on mobile for better typing experience.
 */
export function useTextareaProps() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return {
      autoComplete: 'off' as const,
      autoCorrect: 'on' as const,
      autoCapitalize: 'on' as const,
      spellCheck: true,
    };
  }

  return {
    autoComplete: 'off' as const,
    autoCorrect: 'off' as const,
    autoCapitalize: 'off' as const,
    spellCheck: true,
  };
}
