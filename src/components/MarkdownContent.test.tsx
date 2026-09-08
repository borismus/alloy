import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MarkdownContent } from './MarkdownContent';

afterEach(cleanup);

function renderMarkdown(content: string) {
  return render(<MarkdownContent content={content} />).container;
}

/** Text content excluding KaTeX output (which embeds the TeX source in a MathML annotation). */
function textOutsideMath(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.katex').forEach((el) => el.remove());
  return clone.textContent ?? '';
}

describe('MarkdownContent math delimiters', () => {
  it('renders LaTeX \\(...\\) inline delimiters as math', () => {
    // Real payload from a stored conversation: models emit LaTeX's standard
    // inline delimiters, which remark-math does not parse and CommonMark
    // strips to bare parentheses.
    const container = renderMarkdown('Reynolds number: \\(Re=VL/\\nu\\)');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('(Re=VL/');
  });

  it('renders LaTeX \\[...\\] display delimiters as display math', () => {
    const container = renderMarkdown('\\[\nFr=\\frac{V}{\\sqrt{gL}}\n\\]');
    expect(container.querySelector('.katex-display')).not.toBeNull();
    expect(textOutsideMath(container)).not.toContain('\\frac');
  });

  it('renders tables in an accessible horizontal scroller', () => {
    const container = renderMarkdown(
      '| Regime | Range |\n|---|---|\n| Transition | around \\(Fr=0.5\\) |',
    );
    const scroller = container.querySelector('.markdown-table-scroll');
    expect(scroller?.getAttribute('role')).toBe('region');
    expect(scroller?.getAttribute('aria-label')).toBe('Scrollable table');
    expect(scroller?.getAttribute('tabindex')).toBe('0');
    expect(scroller?.querySelector('table td .katex')).not.toBeNull();
  });

  it('leaves \\(...\\) inside fenced code blocks untouched', () => {
    const container = renderMarkdown('```\n\\(Re=VL/\\nu\\)\n```');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('code')?.textContent).toContain('\\(Re=VL/\\nu\\)');
  });

  it('leaves \\(...\\) inside inline code untouched', () => {
    const container = renderMarkdown('use `\\(x\\)` in LaTeX');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('\\(x\\)');
  });

  it('does not treat an escaped backslash before [ as a math opener', () => {
    // `\\[2mm]` is TeX row-break spacing, not a display-math delimiter.
    const container = renderMarkdown('spacing \\\\[2mm] more text');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('leaves an unmatched \\( literal', () => {
    const container = renderMarkdown('an unmatched \\( paren');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('still renders $$...$$ display math', () => {
    const container = renderMarkdown('$$E=mc^2$$');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('still renders $...$ inline math', () => {
    const container = renderMarkdown('the arrow $\\rightarrow$ here');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('still escapes currency dollars, including after math normalization', () => {
    const container = renderMarkdown('costs $5 now and \\(x=1\\) holds');
    expect(container.textContent).toContain('$5');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders digit-leading inline math like $10^3$', () => {
    const container = renderMarkdown('Mass scales by $10^3$: a 4 kg model');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(textOutsideMath(container)).not.toContain('$10^3$');
  });

  it('keeps a currency range literal', () => {
    const container = renderMarkdown('between $5 and $10 later');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$5');
    expect(container.textContent).toContain('$10');
  });
});
