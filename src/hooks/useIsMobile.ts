import { useState, useEffect } from 'react';

/**
 * When Alloy uses its mobile layout.
 *
 * Width alone is not enough: a phone in landscape is ~874 CSS px wide, above any
 * sensible width breakpoint, yet only ~400px tall — it was getting the desktop
 * layout on a viewport half the height of a portrait phone. Match short *touch*
 * viewports too, while leaving large touch devices (iPad in landscape, 768px+
 * tall) and short desktop windows (fine pointer) on the desktop layout.
 *
 * Kept in sync by hand with the `@media` blocks in the feature stylesheets;
 * plain CSS has no way to share a named query, so both copies must move
 * together.
 */
export const MOBILE_MEDIA_QUERY = '(max-width: 768px), (max-height: 500px) and (pointer: coarse)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isMobile;
}
