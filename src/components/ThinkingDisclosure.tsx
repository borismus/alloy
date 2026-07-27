import { useEffect, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

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
    <Disclosure
      className={`thinking-disclosure ${active ? 'active' : 'finished'}`}
      isDisabled={!expandable}
    >
      <Heading className="thinking-disclosure-heading">
        <Button slot="trigger" className="thinking-disclosure-toggle">
          {expandable && (
            <svg className="thinking-chevron" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M4.5 2.5 8 6l-3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span>{label}</span>
        </Button>
      </Heading>
      {expandable && (
        <DisclosurePanel className="thinking-disclosure-body">{body}</DisclosurePanel>
      )}
    </Disclosure>
  );
}
