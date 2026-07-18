import { useEffect, useState } from 'react';

interface ThinkingDisclosureProps {
  thinking: string;
  startedAt: number;
  initialElapsedMs: number;
  durationMs?: number;
  active: boolean;
}

export function ThinkingDisclosure({
  thinking,
  startedAt,
  initialElapsedMs,
  durationMs,
  active,
}: ThinkingDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(startedAt + initialElapsedMs);
  const body = thinking.trimStart();
  const expandable = body.trim().length > 0;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsedMs = durationMs ?? Math.max(0, now - startedAt);
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const label = active ? `Thinking… ${seconds}s` : `Thought for ${seconds}s`;

  return (
    <div className={`thinking-disclosure ${active ? 'active' : 'finished'} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="thinking-disclosure-toggle"
        onClick={() => expandable && setExpanded(value => !value)}
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
      >
        {expandable && <span className="thinking-chevron" aria-hidden="true">›</span>}
        <span>{label}</span>
      </button>
      {expanded && expandable && (
        <div className="thinking-disclosure-body">{body}</div>
      )}
    </div>
  );
}
