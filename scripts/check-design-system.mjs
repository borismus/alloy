#!/usr/bin/env node
// Enforces the CSS half of docs/design-system.md; the markup half (no raw
// <button>/<select>/<input>) is an ESLint rule in eslint.config.js.
//
// Every stylesheet under src/ must take colors, font sizes, radii and stacking
// from src/styles/tokens.css, and use the one mobile breakpoint. A line that
// genuinely needs a literal says why with a trailing `/* ds-allow: reason */`.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
// tokens.css defines the values; the debug overlay is a diagnostic that must
// stay legible over any theme.
const EXEMPT = new Set(['src/styles/tokens.css', 'src/components/DebugOverlay.module.css']);

const MOBILE_QUERY = '(max-width: 768px), (max-height: 500px) and (pointer: coarse)';
const LEGACY_VARS = /var\(--(border-color|bg-(primary|secondary|tertiary|hover)|text-(primary|secondary|tertiary|muted)|accent-(color|hover)|(warning|success|info)-(text|bg))\b/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(|(?<![-\w])(white|black)\b/;
const COLOR_PROPS = /^\s*(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|text-decoration-color|accent-color|--[\w-]+)\s*:/;

const rules = [
  {
    name: 'legacy color variable (use the --color-* token it aliases)',
    test: (line) => LEGACY_VARS.test(line),
  },
  {
    name: 'literal color (use a --color-* token)',
    test: (line) => COLOR_PROPS.test(line) && COLOR_LITERAL.test(line.replace(/url\([^)]*\)/g, '')),
  },
  {
    name: 'z-index outside the --z-* scale',
    test: (line) => {
      const m = line.match(/^\s*z-index\s*:\s*([^;]+);/);
      return m && !/^(var\(--z-[\w-]+\)|-1|0|1|auto|inherit)$/.test(m[1].trim());
    },
  },
  {
    name: 'font-size outside the --text-* scale',
    test: (line) => {
      const m = line.match(/^\s*font-size\s*:\s*([^;]+);/);
      return m && !/^(var\(--text-[\w-]+\)|inherit|[\d.]+em|100%)$/.test(m[1].trim());
    },
  },
  {
    name: 'border-radius outside the --radius-* scale',
    test: (line) => {
      const m = line.match(/^\s*border(-(top|bottom)-(left|right))?-radius\s*:\s*([^;]+);/);
      return m && !m[4].trim().split(/\s+(?![^(]*\))/).every(
        (v) => /^(var\(--radius-[\w-]+\)|0|50%|inherit)$/.test(v),
      );
    },
  },
  {
    name: `viewport media query other than the mobile breakpoint ${MOBILE_QUERY}`,
    test: (line) => {
      const m = line.match(/^\s*@media\s+(.+?)\s*\{/);
      return m && /(min|max)-(width|height)/.test(m[1]) && m[1] !== MOBILE_QUERY;
    },
  },
];

function* cssFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* cssFiles(path);
    else if (entry.name.endsWith('.css')) yield path;
  }
}

const problems = [];
for (const file of cssFiles(SRC)) {
  const rel = relative(ROOT, file);
  if (EXEMPT.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  let inComment = false;
  lines.forEach((raw, i) => {
    if (/ds-allow:/.test(raw)) return;
    // Drop comments so prose such as "white text" doesn't trip a rule.
    let line = raw;
    if (inComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inComment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, '');
    const start = line.indexOf('/*');
    if (start >= 0) {
      line = line.slice(0, start);
      inComment = true;
    }
    for (const rule of rules) {
      if (rule.test(line)) problems.push(`${rel}:${i + 1}  ${rule.name}\n    ${raw.trim()}`);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} design-system violation(s). See docs/design-system.md.`);
  process.exit(1);
}
console.log('design system: ok');
