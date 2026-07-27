# Backlog

Tasks for the autonomous backlog runner (`scripts/backlog-runner.sh`).
Each `- [ ]` is one self-contained task. The runner picks the first open one,
works it on an `auto/<slug>` branch, verifies, and opens a PR for review.

Keep tasks small and unambiguous — one PR's worth of work each.

- [x] Add a unit test file src/utils/ids.test.ts for generateMessageId in src/utils/ids.ts, asserting the returned id matches the pattern msg-<4 hex chars>
- [x] Fix: in web mode (no Tauri, run via `npm run dev`), newly-created conversations don't appear in the sidebar until a manual reload, whereas Tauri mode updates live. In Tauri the vault watcher uses native `fs.watch`; in web it relies on the WebSocket file watcher in src/services/api/tauri-fs-http.ts (`/api/watch`) feeding useVaultWatcher, which drives App.tsx's `handleConversationAdded`/`handleConversationModified`. Investigate whether the server's watch endpoint emits `conversations/*.yaml` create events in standalone server mode (alloy-server notify/watch route) and whether the client watcher path-matching dispatches them. Expected: a new conversation file appearing in the vault while web mode is running shows up in the sidebar without a refresh, matching Tauri behavior.
- [x] Investigate high memory usage: the Alloy app was observed using ~8GB RAM at one point. It's a spike/leak, not steady state (normal is ~200MB WebKit WebContent + ~120MB native `Alloy` backend). Already ruled out on a first pass: RiffView's 1s `setInterval(loadDraft)` (has clearInterval cleanup), the WS file watcher in src/services/api/tauri-fs-http.ts (single socket, guarded reconnect), and the SSE `replay` handler in src/services/server-streaming.ts (dedups via `displayedLength`, so reconnects don't re-append). Leads to check: (1) mermaid/cytoscape diagram rendering during streaming — MarkdownContent re-renders on every chunk and mermaid is known to leak DOM/SVG on repeated renders; verify MermaidDiagram.tsx / DiagramBlock.tsx debounce and clean up. (2) base64 image data held in React state (vault loadImageAsBase64 / attachments). (3) the native `Alloy` backend (alloy-server) — tool file reads / large buffers in tool_loop and tools/. (4) src/utils/lineDiff.ts allocates an O(m·n) number[][] LCS table with no size cap — add a guard that short-circuits (skip collapse / fall back to a whole-block replace diff) when line counts exceed a threshold. Deliverable: identify the dominant contributor and add a bounded fix or guard for it.
- [x] Canonical config.yaml schema (v1) — DONE (schema portion). camelCase throughout; all providers under `providers:` with kinds openai_compatible / cli_claude; per-provider `local` flag (mlx-only privacy: padlock, private-dir access, offline tolerance; CLI kinds always cloud; public-URL safety rail); `version: 1`. Rust `config.rs` fails loudly on the old pre-0.4 format (no migration). SPA types, default template, first-run writer, and onboarding updated to v1 (native-provider cards dropped — all cloud via OpenRouter). Docs updated. 142 Rust + 126 TS tests pass. REMAINING (split to the follow-up below): making Rust the single parser via `/api/config` so the SPA stops using js-yaml.
- [x] Single-parser consolidation — DONE. Rust `config.rs` is the only config parser. Added `GET /api/config` (resolved config, provider API keys omitted; `sonioxApiKey` included for client-side dictation) and `PUT /api/config/favorites` + `PUT /api/config/value` (comment-preserving line splices ported from the SPA, with Rust tests). `src/services/vault.ts` now fetches `/api/config` and posts edits — removed the config `yaml.load`/`yaml.dump`, the dead `saveConfig`, and the splice helpers. First-run still writes the initial raw template (bootstrap, not a parser). 146 Rust + 116 TS tests pass.
<!-- Design notes for the (now-landed) canonical config schema, kept for context:
  SCHEMA (v1): top-level `version: 1`, `defaultModel`, `favoriteModels`, `models`, `providers:` (list), `settings` (`externalEditor`, `shareOnNetwork`, `sharePort`), `services` (`email: {provider, apiKey, from, to}`), `privateReadOnlyDirs`, `compaction {enabled, triggerTokens}`, `serperApiKey`, `sonioxApiKey`. Everything camelCase.
  PROVIDERS: each entry `{ id, kind, baseUrl?, apiKey?, command?, oauthToken?, local? }`. Kinds: `openai_compatible` (OpenRouter cloud, oMLX local), `cli_claude`, and `cli_codex` (recognize the kind now; the impl is a separate task). Drop ALL legacy flat keys (`OPENROUTER_API_KEY`, `ANTHROPIC/OPENAI/GEMINI/XAI_API_KEY`, `CLAUDE_SUBSCRIPTION`, `CLAUDE_CODE_*`) and the `default_model`/`defaultModel` + snake/camel dual aliases from both Rust and TS.
  PRIVACY (`local`): `local: true` is privacy/offline and MLX-ONLY — it drives the padlock badge, eligibility to read `privateReadOnlyDirs`, and offline-tolerance (unreachable = temporarily offline, not a config error). `claude-cli` (and future `codex-cli`) are LOCAL PROCESSES but CLOUD DATA (prompts go to Anthropic/OpenAI) — never `local`, never private-dir access. When `local` is omitted, default from the endpoint (loopback → true); an explicit flag overrides; as a safety rail, gate private-dir reads on the endpoint not being a public host and warn if `local: true` is set on a public URL.
  SINGLE PARSER: Rust `config.rs` is the only parser. Remove js-yaml parsing/writing from the SPA (`vault.ts` getConfig/saveConfig/favorites, VaultSetup). Expose resolved config via a `/api/config` GET and route edits (favorites, share toggle, external editor) through endpoints; keep atomic writes; never log secrets.
  NO MIGRATION: if a loaded config still has old-shape keys, fail loudly with a clear onboarding/Settings message pointing at the v1 shape — don't silently start with zero providers.
  ALSO UPDATE: first-run VaultSetup writes v1; Settings; TS `Config`/`ProviderConfig` types (drop legacy key fields, add `local`, add `cli_codex` to the kind union); Rust + TS tests; docs (README, SETUP, CLAUDE.md). Preserve behavior: model IDs/defaults/favorites, MLX locality/privacy, Claude subscription auth, scheduled tasks, sharing, services (email), compaction, private dirs. Preserve Tauri and server modes.
-->
- [ ] Add a `codex-cli` provider (kind `cli_codex`) to alloy-server, sibling to `cli_claude`: shell out to the local `codex` CLI non-interactively, deny unsupported interactive tools (mirror the DISALLOWED_NATIVE_TOOLS handling in cli_claude.rs), and map it to the provider interface. Uses the user's ChatGPT/Codex subscription; prompts go to OpenAI, so it is CLOUD for data-safety (not `local`, no private-dir access). Register the kind (already recognized by the v1 schema), add a config example + docs, and tests. Depends on the canonical config schema task.

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

  step 8 tokenization DONE: every feature + secondary stylesheet now maps
         surface/text/border/accent/status hex to tokens; verified sidebar, chat,
         markdown, and settings in dark via CSS fixtures. Remaining hardcoded hex are
         intentional (badge gradients, status indicators, search-highlight yellows,
         syntax colors, the dark Toast overlay, favorite-star colors).

DEFERRED (product decision, not a bug):
  Theme DEFAULT is still 'light' (src/theme.tsx DEFAULT_PREFERENCE). Now that dark
  mode is visually complete, flipping the default to 'system' is safe but changes
  default appearance for dark-OS users — confirm before flipping.
  step 6 optional polish: swap ItemHeader back/close buttons to the ui Button and
  confirm composer 48px rhythm. Low priority; ItemHeader.css already tokenizes via
  aliases. (Overlaps the new 'settings gear' task below, which also touches ItemHeader.)

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
- [x] UI foundation, step 8 — completion sweep. Tokenized hardcoded colors across every feature + secondary stylesheet so dark mode is visually complete; removed the orphaned `useClickOutside` hook. Verified sidebar/chat/markdown/settings in dark via CSS fixtures; 121 vitest tests pass. Intentional exceptions kept (badge gradients, status colors, search highlights, syntax colors, dark Toast overlay, star colors). NOT included: flipping the theme default from 'light' to 'system' (deferred — see status block).

- [x] UI polish — replace the sidebar type-filter `<select className="filter-dropdown">` in `src/components/Sidebar.tsx` with a segmented tab control (All / Chats / Notes / Tasks / Riffs), matching the React Aria prototype. Reuse the tokenized segmented-control pattern from the Settings Appearance control (`.settings-theme-group`), or a React Aria `ToggleButtonGroup`, styled with tokens. Preserve the existing `TimelineFilter` values, `onFilterChange` behavior, and active-filter highlight; support keyboard arrow navigation. Remove the now-unused `.filter-dropdown` CSS. The five tabs must fit the ~280px sidebar and degrade acceptably on mobile (wrap or horizontal scroll).
- [x] UI polish — add a visible settings affordance (gear in the header, via a SettingsLauncher context; done).
- [x] UI polish — add a `ui/Switch` primitive (React Aria `Switch`) and migrate the Settings “Share on network” toggle to it (done).
- [x] UI polish — migrate ThinkingDisclosure to a React Aria `Disclosure` (done; keyboard/ARIA, `[data-expanded]` chevron, `[hidden]` panel rule; interaction-tested).
- [x] UI polish — add a `ui/Tooltip` (React Aria `Tooltip` + `TooltipTrigger` + `Focusable`) and apply it to the header settings/close buttons and the composer attach/send buttons (done; tokenized, interaction-tested). Follow-up if wanted: extend to the header back/forward buttons (dynamic/disabled) and the model picker.
