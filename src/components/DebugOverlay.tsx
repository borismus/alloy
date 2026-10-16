import { useEffect, useState } from 'react';
import { DEBUG_OVERLAY_CHANGED, getDebugOverlay } from '../services/debugOverlay';
import styles from './DebugOverlay.module.css';

/** How often the readout refreshes, in ms. iOS fires no event for some of the
 *  transitions this is meant to catch, so it polls instead of listening. */
const POLL_MS = 200;

interface Tap {
  x: number;
  y: number;
  label: string;
}

function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return '?';
  const cls = typeof target.className === 'string' ? target.className.split(' ')[0] : '';
  const rect = target.getBoundingClientRect();
  return `${target.tagName.toLowerCase()}${cls ? `.${cls}` : ''} [${Math.round(rect.top)}..${Math.round(rect.bottom)}]`;
}

function readMetrics(): string[] {
  const vv = window.visualViewport;
  const docStyle = document.documentElement.style;
  const root = document.getElementById('root')?.getBoundingClientRect();
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  return [
    `scrollY ${window.scrollY}  docEl.scrollTop ${document.documentElement.scrollTop}`,
    vv
      ? `vv.top ${vv.offsetTop.toFixed(1)}  vv.h ${vv.height.toFixed(1)}  pageTop ${vv.pageTop.toFixed(1)}`
      : 'no visualViewport',
    `innerH ${window.innerHeight}  --app-top ${docStyle.getPropertyValue('--app-top') || '-'}  --app-h ${docStyle.getPropertyValue('--app-height') || '-'}`,
    `#root top ${root ? root.top.toFixed(1) : '-'}  active ${document.activeElement?.tagName ?? '-'}  ${standalone ? 'standalone' : 'browser'}`,
  ];
}

/**
 * Live viewport readout plus a marker where each tap registered, for chasing
 * mobile layout bugs where what is drawn and what receives taps disagree.
 * Toggled per device in Settings → Diagnostics.
 */
export function DebugOverlay() {
  const [enabled, setEnabled] = useState(getDebugOverlay);
  const [lines, setLines] = useState<string[]>([]);
  const [tap, setTap] = useState<Tap | null>(null);

  useEffect(() => {
    const onChange = (e: Event) => setEnabled((e as CustomEvent<boolean>).detail);
    window.addEventListener(DEBUG_OVERLAY_CHANGED, onChange);
    return () => window.removeEventListener(DEBUG_OVERLAY_CHANGED, onChange);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => setLines(readMetrics());
    tick();
    const interval = setInterval(tick, POLL_MS);
    // Capture phase, so a handler that stops propagation can't hide the tap.
    const onPointerDown = (e: PointerEvent) => {
      setTap({ x: e.clientX, y: e.clientY, label: `y=${Math.round(e.clientY)} -> ${describeTarget(e.target)}` });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      clearInterval(interval);
      document.removeEventListener('pointerdown', onPointerDown, true);
      setTap(null);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <div className={styles.readout} data-testid="debug-overlay">
        {[...lines, `tap ${tap?.label ?? 'none'}`].join('\n')}
      </div>
      {tap && <div className={styles.tapMarker} style={{ left: tap.x, top: tap.y }} />}
    </>
  );
}
