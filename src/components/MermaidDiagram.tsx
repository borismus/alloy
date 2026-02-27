import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let mermaidInitialized = false;

function ensureMermaidInit() {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        primaryColor: '#e8eaf0',
        primaryTextColor: '#1a1a2e',
        primaryBorderColor: '#9a9ab0',
        lineColor: '#6b6b80',
        secondaryColor: '#f0f0f5',
        tertiaryColor: '#f5f5fa',
        // Mindmap level colors — all light fills with readable dark text
        cScale0: '#dce4f0',
        cScale1: '#d5e6d8',
        cScale2: '#f0e4d0',
        cScale3: '#e0d4e8',
        cScale4: '#d0e4e4',
        cScale5: '#f0d8d8',
        cScale6: '#e4e4d0',
        cScale7: '#d8e0f0',
        cScale8: '#e8dcd0',
        cScale9: '#d0e0d4',
        cScale10: '#e4d8e4',
        cScale11: '#dce8d8',
        cScaleLabel0: '#1a1a2e',
        cScaleLabel1: '#1a1a2e',
        cScaleLabel2: '#1a1a2e',
        cScaleLabel3: '#1a1a2e',
        cScaleLabel4: '#1a1a2e',
        cScaleLabel5: '#1a1a2e',
        cScaleLabel6: '#1a1a2e',
        cScaleLabel7: '#1a1a2e',
        cScaleLabel8: '#1a1a2e',
        cScaleLabel9: '#1a1a2e',
        cScaleLabel10: '#1a1a2e',
        cScaleLabel11: '#1a1a2e',
      },
      mindmap: {
        padding: 20,
        useMaxWidth: false,
      },
      flowchart: {
        padding: 16,
        nodeSpacing: 50,
        rankSpacing: 50,
        useMaxWidth: false,
      },
    });
    mermaidInitialized = true;
  }
}

interface MermaidDiagramProps {
  code: string;
}

let renderCounter = 0;

const CROSSFADE_MS = 300;

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code }) => {
  const layerARef = useRef<HTMLDivElement>(null);
  const layerBRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const lastRenderedCodeRef = useRef<string>('');
  // Which layer is currently visible: 'a' or 'b'
  const activeLayerRef = useRef<'a' | 'b'>('a');

  useEffect(() => {
    if (!code.trim() || !layerARef.current || !layerBRef.current) return;
    if (code.trim() === lastRenderedCodeRef.current) return;

    ensureMermaidInit();

    const id = `mermaid-${++renderCounter}`;
    let cancelled = false;

    (async () => {
      try {
        const { svg } = await mermaid.render(id, code.trim());
        if (cancelled || !layerARef.current || !layerBRef.current) return;

        lastRenderedCodeRef.current = code.trim();
        setError(null);

        const activeEl = activeLayerRef.current === 'a' ? layerARef.current : layerBRef.current;
        const inactiveEl = activeLayerRef.current === 'a' ? layerBRef.current : layerARef.current;

        if (!activeEl.innerHTML) {
          // First render — show immediately on active layer
          activeEl.innerHTML = svg;
          activeEl.style.opacity = '1';
        } else {
          // Place new SVG in inactive layer, then crossfade
          inactiveEl.innerHTML = svg;
          // Force reflow so transition triggers from opacity 0
          inactiveEl.offsetHeight;

          // Crossfade: active out, inactive in
          activeEl.style.opacity = '0';
          inactiveEl.style.opacity = '1';

          // Flip which layer is active (no content swap needed)
          activeLayerRef.current = activeLayerRef.current === 'a' ? 'b' : 'a';
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to render diagram');
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

  const layerStyle: React.CSSProperties = {
    gridArea: '1 / 1',
    transition: `opacity ${CROSSFADE_MS}ms ease-in-out`,
  };

  return (
    <div className="mermaid-diagram" style={{ display: 'grid' }}>
      <div ref={layerARef} style={{ ...layerStyle, opacity: 1 }} />
      <div ref={layerBRef} style={{ ...layerStyle, opacity: 0 }} />
    </div>
  );
};
