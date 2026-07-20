import React, { useState } from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import { CopyButton } from './CodeBlock';
import './DiagramBlock.css';

type DiagramKind = 'mermaid' | 'svg';

interface DiagramBlockProps {
  kind: DiagramKind;
  code: string;
  /** The already-highlighted `<code>` element from react-markdown. */
  children?: React.ReactNode;
}

/**
 * A fenced mermaid/svg block that shows source by default. Rendering is an
 * explicit action, avoiding asynchronous layout shifts during normal reading.
 */
export const DiagramBlock: React.FC<DiagramBlockProps> = ({ kind, code, children }) => {
  const [view, setView] = useState<'code' | 'render'>('code');

  return (
    <div className="diagram-block">
      <div className="diagram-view-toggle" role="group" aria-label="Diagram view">
        <button
          type="button"
          className={view === 'code' ? 'active' : ''}
          onClick={() => setView('code')}
          aria-pressed={view === 'code'}
        >
          code
        </button>
        <span aria-hidden="true">/</span>
        <button
          type="button"
          className={view === 'render' ? 'active' : ''}
          onClick={() => setView('render')}
          aria-pressed={view === 'render'}
        >
          render
        </button>
      </div>

      {view === 'code' ? (
        <pre className="diagram-code">{children ?? <code>{code}</code>}</pre>
      ) : (
        <div className="diagram-render">
          {kind === 'mermaid' ? <MermaidDiagram code={code} /> : <SvgImage code={code} />}
        </div>
      )}

      <CopyButton text={code} className="block-copy" />
    </div>
  );
};

/**
 * Render raw SVG markup as an `<img>` data-URI. SVG loaded via `<img>` cannot
 * execute scripts or load external resources, unlike injecting raw markup.
 */
function SvgImage({ code }: { code: string }) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
  return <img className="diagram-svg" src={src} alt="SVG diagram" />;
}
