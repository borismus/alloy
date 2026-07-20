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
      <span className="diagram-language">{kind}</span>
      <button
        type="button"
        className="diagram-view-toggle"
        onClick={() => setView((current) => current === 'code' ? 'render' : 'code')}
        aria-label={`Switch to ${view === 'code' ? 'rendered diagram' : 'source code'}`}
      >
        <span className={view === 'code' ? 'active' : ''}>Code</span>
        <span className={view === 'render' ? 'active' : ''}>Render</span>
      </button>

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
