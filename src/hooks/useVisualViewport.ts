import { useEffect } from 'react';

/**
 * Re-read points after an orientation change, in ms. iOS reports transitional
 * viewport metrics while the rotation animation runs and does not reliably fire
 * a final `visualViewport` resize once it settles, so a single measurement can
 * be left describing the previous orientation. Sampling across the animation is
 * cheap (a few style writes) and converges on the settled value.
 */
const RESETTLE_DELAYS_MS = [50, 150, 350, 600];

/**
 * Tracks the visual viewport and sets CSS vars so the app always
 * fills it exactly — even when WKWebView scrolls the layout viewport
 * to accommodate the software keyboard.
 *
 * --app-height: visual viewport height
 * --app-top: visual viewport offset (how far the page has scrolled)
 *
 * These drive `html, body, #root { position: fixed; height: var(--app-height) }`
 * and every scroll container beneath them, so a stale value doesn't just look
 * wrong — it gives the scrollers the wrong extent and scrolling stops working.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Track what we last wrote so a burst of events (rotation fires several)
    // doesn't churn inline styles and force redundant layout.
    let lastHeight = '';
    let lastTop = '';

    const update = () => {
      const style = document.documentElement.style;
      const height = `${vv.height}px`;
      const top = `${vv.offsetTop}px`;
      if (height !== lastHeight) {
        style.setProperty('--app-height', height);
        lastHeight = height;
      }
      if (top !== lastTop) {
        style.setProperty('--app-top', top);
        lastTop = top;
      }
    };

    // Re-measure across the rotation animation rather than trusting the single
    // event that starts it.
    const timers: ReturnType<typeof setTimeout>[] = [];
    let frame = 0;
    const resettle = () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
      update();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
      for (const delay of RESETTLE_DELAYS_MS) {
        timers.push(setTimeout(update, delay));
      }
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // `orientationchange` is the reliable signal that a rotation happened;
    // window `resize` is the backup for engines that only fire that one.
    window.addEventListener('orientationchange', resettle);
    window.addEventListener('resize', resettle);

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', resettle);
      window.removeEventListener('resize', resettle);
    };
  }, []);
}
