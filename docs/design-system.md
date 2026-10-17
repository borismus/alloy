# Alloy design system

Alloy's UI is built from three layers. Use the highest layer that fits:

1. **Shared components** (`src/components/`): whole patterns such as the item
   header or the header actions.
2. **Primitives** (`src/components/ui/`): controls built on React Aria, styled
   with CSS Modules.
3. **Tokens** (`src/styles/tokens.css`): every color, size, radius, shadow,
   z-index and duration.

Feature CSS styles layout: where things go, how much room they get. It does
not invent colors, type sizes, radii or controls.

`npm run lint` enforces the mechanical rules: ESLint rejects raw controls, and
`scripts/check-design-system.mjs` rejects off-scale CSS. A line that really
needs an exception ends with `/* ds-allow: reason */`.

## Tokens

All tokens live in `src/styles/tokens.css`. Light values are on `:root`; the
ThemeProvider sets `data-theme="dark"` on `<html>`, which overrides the color and
shadow tokens. Nothing else in the app branches on the theme.

### Color

| Token | Use |
|---|---|
| `--color-canvas` | Page background behind content (chat, note, task) |
| `--color-surface` | Sidebar, headers, the composer bar |
| `--color-surface-raised` | Cards, dialogs, inputs, menus |
| `--color-surface-hover`, `--color-surface-pressed` | Hover and pressed fills for rows and quiet controls |
| `--color-border`, `--color-border-strong` | Dividers and control borders; `strong` on hover |
| `--color-text`, `--color-text-secondary`, `--color-text-muted` | Body text, supporting text, hints and metadata |
| `--color-accent`, `--color-accent-strong`, `--color-accent-end` | Brand accent; `strong` for hover or text on soft fills; `end` closes the gradient |
| `--color-accent-soft` | Selected rows, accent badges |
| `--color-on-accent` | Text and icons on the accent gradient or a danger fill |
| `--color-danger`, `--color-success`, `--color-warning` and their `-soft` pairs | Status: the strong value for text and icons, `-soft` for fills |
| `--color-focus` | Focus rings (via `--shadow-focus` or a 3px outline) |
| `--color-overlay` | Dialog scrim |
| `--color-chip`, `--color-chip-border`, `--color-track`, `--color-code-bg` | Neutral chips, progress tracks, code |
| `--color-syntax-*` | Code highlighting only |

Need a color that isn't here? Add a token, with light and dark values, rather
than a literal. A literal is right only when it must not follow the theme (a
diagnostic overlay) and then it carries `ds-allow`.

### Type

`--font-ui` for everything; `--font-mono` for code, ids and numbers that should
line up.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 0.7rem | Badges, timestamps, metadata |
| `--text-sm` | 0.8rem | Secondary text, small buttons, labels |
| `--text-md` | 0.9rem | Body and controls (the default) |
| `--text-base` | 1rem | Message and note text |
| `--text-lg` | 1.125rem | Item titles |
| `--text-xl` | 1.25rem | Dialog titles |

Relative `em` sizes are fine inside content that should scale with its parent
(Markdown headings, inline code).

### Spacing

A 4px grid: `--space-1` (4px), `-2` (8), `-3` (12), `-4` (16), `-5` (20),
`-6` (24), `-8` (32), `-12` (48). Lay out siblings with flex or grid and `gap`
rather than margins on each child. Off-grid values are for optical alignment
only (centering an icon in a fixed box, for example).

### Shape, elevation, motion, stacking

- **Radius:**
  - `--radius-sm` (4px): badges and small chips;
  - `--radius-control` (6px): buttons and inputs;
  - `--radius-md` (8px): cards, menus and popovers;
  - `--radius-panel` (12px): dialogs, the composer and message bubbles;
  - `--radius-pill`: fully round chips;
  - `50%`: circles.
- **Shadow:**
  - `--shadow-control`: the primary button;
  - `--shadow-popover`: menus, tooltips and popovers;
  - `--shadow-dialog`: dialogs;
  - `--shadow-focus`: focus rings drawn as a shadow.
- **Gradient:** `--gradient-accent` for primary actions and the user's message
  bubble.
- **Motion:** `--duration-fast` (hover, press) and `--duration-normal`
  (enter/exit) with `--ease-standard`. Respect `prefers-reduced-motion` for
  anything that loops.
- **Stacking**, lowest to highest: `--z-raised`, `--z-header`, `--z-findbar`,
  `--z-popover`, `--z-dialog`, `--z-toast`, `--z-menu`, `--z-debug`. Plain `1`
  is fine for stacking inside a component.

### Breakpoint

There is one: the mobile layout.

```css
@media (max-width: 768px), (max-height: 500px) and (pointer: coarse) { … }
```

It matches narrow viewports and phones in landscape. In TypeScript use
`useIsMobile()` (`src/hooks/useIsMobile.ts`, which holds the same string as
`MOBILE_MEDIA_QUERY`) rather than testing media queries by hand. Plain CSS can't
share a named query, so the lint check makes sure every copy is identical.
`(hover: none)` and `prefers-*` queries are fine alongside it.

## Primitives (`src/components/ui/`)

Import from `./ui` (the `index.ts` barrel). Primitives take no `className`;
place them with a wrapping element.

| Primitive | Use it for | Notes |
|---|---|---|
| `Button` | Any button with a text label | `variant`: `primary` (one per view, the main action), `secondary` (default), `surface`, `muted`, `quiet` (toolbars, rows), `danger` (destructive confirm). `size`: `small`, `medium`, `icon`, `compactIcon`, `composer` |
| `IconButton` | Icon-only buttons | `label` is required; it becomes the accessible name and the tooltip. Quiet by default |
| `CopyButton` | Copy to clipboard | Shows a check for a moment. Its wrapper takes a `className` and carries `data-copied` |
| `TextField` | Single-line text input | Optional visible `label`; otherwise pass `aria-label` |
| `SearchField` | Search inputs | Includes the clear button |
| `SelectField` | Picking one of a few options | |
| `SegmentedControl` | Two to five mutually exclusive views or modes | e.g. the timeline filter, the theme picker |
| `Switch` | On/off settings that apply immediately | Requires `aria-label` |
| `Badge` | Non-interactive status labels | `tone`: `neutral`, `accent`, `success`, `warning`, `danger`. One shape and size; never wraps |
| `AlloyTooltip` | Hover/focus hints on a pressable | Use instead of `title=` |
| `AlloyDialog` + `DialogBody` + `DialogActions` | Modal dialogs | A bottom sheet on the phone. Actions: Cancel first, the confirming action last; `danger` for destructive confirms |
| `AlloyMenu` | Dropdown menus from a trigger | |

Text areas are the one raw control still allowed: the composer and the edit
panel each need behavior (auto-resize, dictation) that a shared primitive
doesn't have yet.

## Shared components

| Component | Pattern |
|---|---|
| `ItemHeader` | The header of every item view: back, title (with copy), subtitle, actions slot, then `HeaderActions` |
| `HeaderActions` | New conversation [+] and Settings [⚙] at the top right of every header |
| `ContextMenu` (via `useContextMenu`) | Right-click and row menus. Order: item actions, then the editor, then Reveal in Finder, then Delete (`danger`, `separatorBefore`) |
| `MarkdownContent`, `CodeBlock` | Rendering note and message text |
| `ChatInputForm` | Every composer (chat, note edit, task edit) |

## Writing

Sentence case for titles, buttons and menu items ("Rename conversation", not
"Rename Conversation"). Name the thing in confirmations (`Delete "Groceries"?`).
Say what happens and whether it can be undone. Neutral words for states that
aren't errors.
