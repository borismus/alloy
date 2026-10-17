import React, { useState } from 'react';
import { MermaidDiagram, renderMermaidSvg } from './MermaidDiagram';
import { CopyButton, IconButton, SegmentedControl } from './ui';
import './DiagramBlock.css';

type DiagramKind = 'mermaid' | 'svg';
type DiagramView = 'code' | 'render';

const VIEW_OPTIONS = [
  { id: 'code', label: 'Code' },
  { id: 'render', label: 'Render' },
];

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
  const [view, setView] = useState<DiagramView>('code');
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
      <div className="diagram-view-toggle">
        <SegmentedControl
          aria-label="Diagram view"
          options={VIEW_OPTIONS}
          value={view}
          onChange={(next) => setView(next as DiagramView)}
        />
      </div>

      {view === 'code' ? (
        <pre className="diagram-code">{children ?? <code>{code}</code>}</pre>
      ) : (
        <div className="diagram-render">
          {kind === 'mermaid' ? <MermaidDiagram code={code} /> : <SvgImage code={code} />}
        </div>
      )}

      <div className="diagram-actions">
        <IconButton label="Download SVG" size="compactIcon" onPress={download} isDisabled={downloading}>
          <DownloadIcon />
        </IconButton>
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
