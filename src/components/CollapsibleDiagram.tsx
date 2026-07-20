import React, { useState } from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import { CopyButton } from './CodeBlock';
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
 * A fenced diagram block (```mermaid / ```svg) rendered only on demand, with a
 * toggle between the rendered diagram and its source.
 *
 * Diagrams render asynchronously and can be large, so rendering them inline
 * causes late layout shifts — jarring while a message streams or when scrolling
 * a long transcript. Keeping them collapsed until the user clicks means the
 * message body's height is stable; the async render only happens as a
 * deliberate action.
 */
export const CollapsibleDiagram: React.FC<CollapsibleDiagramProps> = ({ kind, code }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'render' | 'code'>('render');

  if (!open) {
    return (
      <div className="diagram-block">
        <button
          type="button"
          className="diagram-toggle"
          onClick={() => setOpen(true)}
          aria-expanded={false}
        >
          <span className="diagram-chevron" aria-hidden="true">›</span>
          <span className="diagram-label">{LABELS[kind]}</span>
          <span className="diagram-hint">Render</span>
        </button>
      </div>
    );
  }

  return (
    <div className="diagram-block open">
      <div className="diagram-toolbar">
        <div className="diagram-segmented" role="tablist">
          <button
            type="button"
            className={view === 'render' ? 'active' : ''}
            onClick={() => setView('render')}
            role="tab"
            aria-selected={view === 'render'}
          >
            Rendered
          </button>
          <button
            type="button"
            className={view === 'code' ? 'active' : ''}
            onClick={() => setView('code')}
            role="tab"
            aria-selected={view === 'code'}
          >
            Code
          </button>
        </div>
        <div className="diagram-toolbar-right">
          <CopyButton text={code} />
          <button type="button" className="diagram-hide" onClick={() => setOpen(false)}>
            Hide
          </button>
        </div>
      </div>
      <div className="diagram-body">
        {view === 'render' ? (
          kind === 'mermaid' ? <MermaidDiagram code={code} /> : <SvgImage code={code} />
        ) : (
          <pre className="diagram-code"><code>{code}</code></pre>
        )}
      </div>
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
