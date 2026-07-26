# Backlog

Tasks for the autonomous backlog runner (`scripts/backlog-runner.sh`).
Each `- [ ]` is one self-contained task. The runner picks the first open one,
works it on an `auto/<slug>` branch, verifies, and opens a PR for review.

Keep tasks small and unambiguous — one PR's worth of work each.

- [x] Add a unit test file src/utils/ids.test.ts for generateMessageId in src/utils/ids.ts, asserting the returned id matches the pattern msg-<4 hex chars>
- [x] Fix: in web mode (no Tauri, run via `npm run dev`), newly-created conversations don't appear in the sidebar until a manual reload, whereas Tauri mode updates live. In Tauri the vault watcher uses native `fs.watch`; in web it relies on the WebSocket file watcher in src/services/api/tauri-fs-http.ts (`/api/watch`) feeding useVaultWatcher, which drives App.tsx's `handleConversationAdded`/`handleConversationModified`. Investigate whether the server's watch endpoint emits `conversations/*.yaml` create events in standalone server mode (alloy-server notify/watch route) and whether the client watcher path-matching dispatches them. Expected: a new conversation file appearing in the vault while web mode is running shows up in the sidebar without a refresh, matching Tauri behavior.
- [x] Investigate high memory usage: the Alloy app was observed using ~8GB RAM at one point. It's a spike/leak, not steady state (normal is ~200MB WebKit WebContent + ~120MB native `Alloy` backend). Already ruled out on a first pass: RiffView's 1s `setInterval(loadDraft)` (has clearInterval cleanup), the WS file watcher in src/services/api/tauri-fs-http.ts (single socket, guarded reconnect), and the SSE `replay` handler in src/services/server-streaming.ts (dedups via `displayedLength`, so reconnects don't re-append). Leads to check: (1) mermaid/cytoscape diagram rendering during streaming — MarkdownContent re-renders on every chunk and mermaid is known to leak DOM/SVG on repeated renders; verify MermaidDiagram.tsx / DiagramBlock.tsx debounce and clean up. (2) base64 image data held in React state (vault loadImageAsBase64 / attachments). (3) the native `Alloy` backend (alloy-server) — tool file reads / large buffers in tool_loop and tools/. (4) src/utils/lineDiff.ts allocates an O(m·n) number[][] LCS table with no size cap — add a guard that short-circuits (skip collapse / fall back to a whole-block replace diff) when line counts exceed a threshold. Deliverable: identify the dominant contributor and add a bounded fix or guard for it.
- [ ] Replace the accumulated `config.yaml` formats with one canonical, versioned schema shared by the SPA and alloy-server. Represent cloud, Claude subscription, and custom OpenAI-compatible endpoints uniformly under `providers:`; remove legacy flat-key handling and duplicated camelCase/snake_case aliases from runtime code. Add an explicit, atomic migration for existing vaults that preserves credentials and user settings, keeps or backs up hand-written comments, never logs secrets, and reports unsupported/stale fields clearly instead of silently ignoring them. Update first-run setup, settings, model/provider types, documentation, and Rust/TypeScript tests together. Preserve Tauri and server mode, model IDs/defaults/favorites, oMLX locality/privacy classification, Claude subscription auth, scheduled tasks, sharing, services, and compaction behavior.

<!--
UI foundation migration (prototype-validated). Approach: React Aria Components for
behavior/accessibility + CSS Modules for styling + a semantic design-token layer;
expose only Alloy-owned wrappers to feature code. Do these in order (each depends on
the previous), strangler-fig style: keep the 98 vitest + Playwright e2e suites green,
keep Tauri and web/server modes working, and delete superseded CSS/hooks only as each
consumer migrates. Validated in WebKit (Safari engine): popover placement, upward
positioning, focus trapping, dialog Escape, and disclosure visibility all pass.
-->

<!--
MIGRATION STATUS (11 commits on main: 93cf6c1 .. d5a281c). All verified with
tsc + eslint (0 errors) + 121 vitest tests (incl. real user-event interaction
tests) + web build; interactions cross-checked in WebKit.

DONE + committed:
  step 1 tokens + ui/ primitives (Button, Dialog, SearchField, SelectField, Menu)
  step 2 theme (light/dark/system, matchMedia, Appearance control); DEFAULT IS
         STILL 'light' on purpose (see src/theme.tsx DEFAULT_PREFERENCE) — do not
         flip to 'system' until step 8 tokenization is complete, or dark looks broken.
  step 3 ModelSelector rebuilt (DialogTrigger + Popover + Autocomplete + ListBox).
         Fixes made after review: (a) favorite star was inert because RA caches rows
         by key — bake `favorite` into each row object; (b) re-selecting the current
         model didn't dismiss — drive picking with ListBox onAction (NOT
         onSelectionChange / selectionMode, which only fires onAction on dbl-click),
         highlight current row via .optionCurrent class. Star = span role=button,
         tabIndex -1, onPointerDown preventDefault+stopPropagation, onClick toggles.
  step 4 all modal dialogs -> AlloyDialog (extended with isOpen/onOpenChange for
         parent-controlled dialogs): Settings + reset, Sidebar rename/delete, riff modal.
  step 5 ContextUsageChip -> DialogTrigger+Popover. DECISION: SlashCommandMenu and
         right-click ContextMenu stay custom (textarea-driven keyboard / no RA
         primitive) and are only tokenized, not rebuilt.
  step 7 riff change review -> RA Disclosure.
  partial step 8: legacy-var aliases in tokens.css tokenize ~130 usages app-wide;
         App.css shell tokenized; dead useClickOutside removed (useGlobalEscape stays).

REMAINING:
  step 6 mostly covered by aliases (ItemHeader.css uses legacy vars). Optional polish:
         swap ItemHeader back/close buttons to the ui Button; confirm composer 48px
         rhythm. Low priority.
  step 8 NOT DONE: the large feature stylesheets still hardcode surface/text hex
         (ChatInterface.css, Sidebar.css, TaskDetailView.css, RiffView.css,
         NoteViewer.css, MarkdownContent.css, VaultSetup.css). Map #333->--color-text,
         #666->--color-text-secondary, #999->--color-text-muted, #e0e0e0->--color-border,
         #f8f9fa->--color-surface, white/#fff->--color-canvas or surface-raised,
         #667eea/#764ba2 gradient -> --color-accent/--color-accent-end. DO NOT blanket
         sed (preserve gradients, syntax-highlight colors, intentionally-dark bits).
         Needs VISUAL verification per surface in the running app (colors aren't tested).
         Then flip theme default to 'system' and verify light + dark.

LESSON: every migrated component needs a real @testing-library/user-event interaction
test (open overlay, click, keyboard), not just a closed-trigger render test — the star
bug and the re-select bug both slipped past render-only tests.

NOTE: pre-existing uncommitted work (Ollama removal / Claude CLI changes across
alloy-server + a few TS/docs) and .claude/settings.local.json are intentionally NOT
committed — keep excluding them; commit UI work with partial-staged package.json.
-->

- [x] UI foundation, step 1 — add the design-system scaffolding without migrating any feature yet. Add the `react-aria-components` dependency (^1.19). Create `src/styles/tokens.css` with semantic tokens (canvas/surface/surface-raised/surface-hover, border/border-strong, text/text-secondary/text-muted, accent/accent-strong/accent-soft, danger/success/warning + soft variants, focus ring, overlay, chip/track/code-bg/added/control-track/scrollbar, radii, shadows, typography, motion, and app metrics) under `:root` (light), plus a `:root[data-theme="dark"]` block overriding the color tokens for dark. Add `src/components/ui/` primitives as thin Alloy wrappers over React Aria + CSS Modules: `Button` (variants primary/secondary/quiet/danger; sizes small/medium/icon/composer), `Dialog` (ModalOverlay+Modal+Dialog with title/close, compact+bottom-sheet-on-mobile), `SearchField`, `SelectField`, `Menu` (Popover+Menu). Do NOT rewire any feature yet; add a render test that mounts each primitive. Note the React Aria state-attribute gotchas found in the prototype: ComboBox root exposes `data-focused` (not `data-focus-within`); SearchField exposes `data-empty` (not `data-has-value`); a DisclosurePanel needs an explicit `.panel[hidden]{display:none}` rule to hide in WebKit.
- [x] UI foundation, step 2 — theming. Add `src/theme.tsx` (ThemeProvider + useTheme) with a `light | dark | system` preference; resolve `system` via `matchMedia('(prefers-color-scheme: dark)')`, apply the result to `document.documentElement.dataset.theme`, and re-resolve on OS change while in system mode. Wrap the app in `main.tsx`. Add an Appearance section to Settings with a Light/Dark/System segmented control wired to `useTheme`. Depends on step 1. Dark mode will only be visually complete for components that already consume tokens; that is expected and finished in step 8. Verify the attribute flips and system detection works; keep existing look unchanged in light mode.
- [x] UI foundation, step 3 — migrate `src/components/ModelSelector.tsx` to the prototype-validated picker and delete its bespoke dropdown logic. Replace the editable-combobox behavior with a trigger `Button` that opens a `Popover` containing React Aria `Autocomplete` (a `SearchField` + a `Menu` with `selectionMode="single"`), so the whole control opens/toggles on click (no text-selection on focus), the search field lives inside the popover, the chevron sits inside the trigger, and selecting closes + updates. Preserve all current behavior: dynamic model catalog, favorites toggle as an independent hit target inside each row, stale-model humanized fallback, relevance ranking, empty states, provider tags, and the local/loopback lock treatment. Style with a `ModelPicker.module.css` using tokens. Remove now-dead state/effects (open state, active index, arrow-key handling, outside-click, above/below flip) and any `useClickOutside` usage this file introduced. This slice is also the manual checkpoint: smoke-test in the real Tauri (WKWebView) shell AND web/browser mode, including upward popover placement and the on-device software keyboard, before proceeding.
- [x] UI foundation, step 4 — migrate modal dialogs to the `Dialog` primitive and remove the duplicated overlay code. Convert `src/components/Settings.tsx` (main dialog + reset-confirm), the Sidebar rename and delete dialogs in `src/components/Sidebar.tsx`, and `src/components/RiffBatchApprovalModal.tsx` to `components/ui/Dialog`, getting focus trap, focus restoration, Escape, and background inertness for free. Delete the superseded `.settings-overlay/.settings-dialog/.rename-modal/.rename-dialog/.riff-modal-*` CSS and the `useGlobalEscape`/manual `stopPropagation` overlay patterns those files used, where fully replaced. Depends on step 1.
- [x] UI foundation, step 5 — migrate lightweight overlays/menus. Migrated `ContextUsageChip` to a React Aria `DialogTrigger` + `Popover` (removing its manual open state and outside-click effect) and tokenized its CSS. Decision on the other two: `SlashCommandMenu` stays custom — its keyboard nav is driven by the composer textarea's keydown (arrows/enter/tab intercepted before submit), which doesn't fit the `Menu` primitive's focus model; it's tokenized in step 8 instead. The right-click `ContextMenu` also stays custom (React Aria has no context-menu primitive; it's already a coordinate-positioned overlay) and is tokenized in step 8. Depends on step 1.
- [ ] UI foundation, step 6 — extract a shared `ItemHeader` pattern (back button + title/subtitle + actions slot) under `src/components/` and adopt it in the chat, note, task, and riff headers (`ItemHeader.tsx` already exists — align it to the token/primitive system and the wrapper Button). Migrate the composer control row (`ChatInputForm` and the riff composer) to shared `Button` sizes with a single 48px desktop rhythm and >=44px touch targets, textarea aligned to the same baseline, and the send button pinned bottom-right on mobile. Keep `useAutoResizeTextarea`/`useTextareaProps` behavior. Depends on steps 1 and 3.
- [x] UI foundation, step 7 — migrate the riff surface patterns. Convert `InterventionCard` to a token-styled pattern (type-colored left border + glyph + dismiss) and the integration review (`RiffBatchApprovalModal`, already on the Dialog primitive from step 4) to use `Disclosure` for per-change expand with a diff-style additions block and reasoning. Depends on steps 1 and 4.
- [ ] UI foundation, step 8 — completion sweep. Tokenize remaining hardcoded colors across component CSS so dark mode is visually complete on every surface (audit for hex literals in `src/components/*.css` and replace with tokens). Delete now-unused stylesheets and interaction hooks left orphaned by steps 3–7 (e.g. `useClickOutside`, `useGlobalEscape`, bespoke dropdown/positioning helpers) once no consumer remains. Confirm the full 98 vitest + Playwright e2e suites pass in both light and dark, Tauri and web modes. Depends on steps 1–7.
