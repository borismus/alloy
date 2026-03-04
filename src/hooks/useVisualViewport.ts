import { useEffect } from 'react';

/**
 * Tracks the visual viewport and sets CSS vars so the app always
 * fills it exactly — even when WKWebView scrolls the layout viewport
 * to accommodate the software keyboard.
 *
 * --app-height: visual viewport height
 * --app-top: visual viewport offset (how far the page has scrolled)
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const style = document.documentElement.style;
      style.setProperty('--app-height', `${vv.height}px`);
      style.setProperty('--app-top', `${vv.offsetTop}px`);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
}
