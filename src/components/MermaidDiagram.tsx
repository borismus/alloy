import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let mermaidInitialized = false;

function ensureMermaidInit() {
  if (!mermaidInitialized) {
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    mermaidInitialized = true;
  }
}

interface MermaidDiagramProps {
  code: string;
}

let renderCounter = 0;

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code.trim() || !containerRef.current) return;

    ensureMermaidInit();

    const id = `mermaid-${++renderCounter}`;
    let cancelled = false;

    (async () => {
      try {
        const { svg } = await mermaid.render(id, code.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to render diagram');
          // Clean up any orphaned render element
          document.getElementById(`d${id}`)?.remove();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">
        <pre><code>{code}</code></pre>
        <div className="mermaid-error-msg">{error}</div>
      </div>
    );
  }

  return <div ref={containerRef} className="mermaid-diagram" />;
};
