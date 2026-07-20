import React, { useState } from 'react';
import { MermaidDiagram, renderMermaidSvg } from './MermaidDiagram';
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
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const svg = kind === 'mermaid' ? await renderMermaidSvg(code) : code;
      downloadSvg(svg, `${kind}-diagram.svg`);
    } catch (error) {
      console.error('Failed to download diagram:', error);
    } finally {
      setDownloading(false);
    }
  };

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

      <div className="diagram-actions">
        <button
          type="button"
          className="block-action-btn"
          onClick={download}
          disabled={downloading}
          title={downloading ? 'Preparing SVG' : 'Download SVG'}
          aria-label="Download SVG"
        >
          <DownloadIcon />
        </button>
        <CopyButton text={code} />
      </div>
    </div>
  );
};

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function downloadSvg(svg: string, filename: string) {
  const content = svg.trimStart().startsWith('<?xml')
    ? svg
    : `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`;
  const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Render raw SVG markup as an `<img>` data-URI. SVG loaded via `<img>` cannot
 * execute scripts or load external resources, unlike injecting raw markup.
 */
function SvgImage({ code }: { code: string }) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
  return <img className="diagram-svg" src={src} alt="SVG diagram" />;
}
