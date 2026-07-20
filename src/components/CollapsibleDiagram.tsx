import React, { useState } from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import './CollapsibleDiagram.css';

type DiagramKind = 'mermaid' | 'svg';

interface CollapsibleDiagramProps {
  kind: DiagramKind;
  code: string;
}

const LABELS: Record<DiagramKind, string> = {
  mermaid: 'Mermaid diagram',
  svg: 'SVG image',
};

/**
 * A fenced diagram block (```mermaid / ```svg) rendered only on demand.
 *
 * Diagrams render asynchronously and can be large, so rendering them inline
 * causes late layout shifts — jarring while a message streams or when scrolling
 * a long transcript. Keeping them collapsed until the user clicks means the
 * message body's height is stable; the async render only happens as a
 * deliberate, in-place action.
 */
export const CollapsibleDiagram: React.FC<CollapsibleDiagramProps> = ({ kind, code }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className={`diagram-block ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="diagram-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="diagram-chevron" aria-hidden="true">›</span>
        <span className="diagram-label">{LABELS[kind]}</span>
        <span className="diagram-hint">{open ? 'Hide' : 'Render'}</span>
      </button>
      {open && (
        <div className="diagram-body">
          {kind === 'mermaid' ? <MermaidDiagram code={code} /> : <SvgImage code={code} />}
        </div>
      )}
    </div>
  );
};

/**
 * Render raw SVG markup as an `<img>` data-URI. SVG loaded via `<img>` can't run
 * scripts or load external resources, so untrusted model output is neutralized —
 * unlike injecting it with innerHTML.
 */
function SvgImage({ code }: { code: string }) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
  return <img className="diagram-svg" src={src} alt="SVG diagram" />;
}
