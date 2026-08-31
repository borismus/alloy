# Changelog

All notable changes to Alloy are documented here. The release workflow
publishes the section matching each version tag (e.g. `## 0.3.2`) as the body
of the corresponding GitHub release, so add a section here before bumping.

## 0.4.16

- **Model favorites are simple again.** Stars now toggle only favorite status;
  they can no longer unexpectedly promote a model to the default. The configured
  default stays fixed above a divider with its own marker, while a separate
  **Set default** row action appears on hover and remains visible on touch
  devices. Default and favorite status are persisted independently.
- **Scheduled-task failures are no longer silent.** The latest failed run gets a
  persistent red sidebar state and a prominent error in task details. Tasks with
  `email: true` send a distinct failure alert on the first error in a consecutive
  failure streak, while deliberate skips remain silent and repeated failures do
  not spam the inbox.

## 0.4.15

- **Your configured default model is now authoritative.** New conversations,
  riffs, and other default-seeded work use `defaultModel` whenever it is
  available, falling back deterministically (first reachable favorite in config
  order, then the catalog) instead of picking a random favorite every time.
- **Three-state model star.** Clicking a model's star in the picker cycles
  hollow → yellow favorite → red default → hollow. There is at most one red
  default; promoting a new one demotes the previous default to a favorite. The
  open picker keeps rows in place while you cycle — fully unstarred models drop
  off on the next open.
- **Codex subscription conversations get real titles.** Title generation now
  uses each provider's own model (Codex uses your account default) instead of
  sending an Anthropic id to the Codex CLI and silently falling back to the
  first 50 characters of your message.
- **Immediate "Preparing images…" feedback.** Sending a message with photo
  attachments shows a progress indicator while they are persisted, instead of
  looking ignored for several seconds; messages sent during preparation queue
  safely.
- **Sidebar `+` creates a conversation in one click.** New riff moved to an
  adjacent overflow menu; on mobile the creation controls live in the header
  with full-size touch targets and search gets its own row.
- **Find-in-conversation is legible in dark mode**, including match highlights.
- Custom oMLX providers (e.g. a second machine) are searchable as "oMLX" in the
  model picker.

## 0.4.14

- **Codex subscription mode now has full interactive parity.** Responses stream
  token-by-token, Stop cancels active turns while preserving partial output,
  image attachments are sent as data URLs, and Codex can use Alloy's scoped
  tools through MCP. Native Codex command, file-change, dynamic-tool, and web
  activity also appears in the conversation.
- **Fixed missing and malformed tool pills.** Tool calls render as soon as they
  begin and persist after reload. Codex web-search pills update in place when the
  CLI supplies the real query, instead of showing duplicate `Searched ""`
  indicators.
- **Fixed run-together Codex prose.** Commentary and final-answer app-server
  messages now retain a paragraph boundary instead of being persisted as text
  such as `input.That confirms`.
- **Sidebar search stays responsive on large vaults.** Typing no longer
  reconciles thousands of timeline rows before the existing search debounce.
- Shared item-header and composer controls now use the same accessible React Aria
  button foundation across chats, notes, tasks, and riffs, without an intentional
  visual redesign.

## 0.4.13

- **Release infrastructure maintenance.** Alloy's GitHub Actions now run on
  Node 24-compatible action versions. This release validates the complete
  build, signing, notarization, publication, and updater pipeline; there are no
  application behavior changes from 0.4.12.

## 0.4.12

- **Fixed conversations reloading and jumping to the bottom when Alloy regains
  focus.** Equal YAML timestamps were parsed into separate objects and mistaken
  for an external file edit, causing the open transcript to be discarded and
  loaded again on every focus.
- **Full-text search now shows matching context and searches every content
  type.** Broad conversation matches can no longer prevent matching notes or
  riffs from appearing, and late responses from an older query cannot leak into
  newer results.

## 0.4.11

- **Search now finds text inside conversations, notes, and riffs.** Full-text
  search runs against the vault on the server instead of depending on which
  documents happen to be loaded in the client. Previously, conversation body
  matches usually appeared only after opening that conversation.
- **Reduced startup data transfer.** Alloy no longer loads every note body just
  to support sidebar search; note contents continue to load on demand when a
  note is opened.

## 0.4.10

- **Fixed the app appearing to refresh itself on desktop.** Alloy re-checks the
  vault whenever its window regains focus; that check rebuilt the sidebar every
  time, even when nothing had changed. It now leaves things alone unless
  something actually changed.
- **Alloy reopens the conversation you were last reading.** Your place was stored
  in a way that iOS discards when it evicts a backgrounded tab, and that a
  desktop restart clears — so it was lost exactly when it mattered.
- **Fixed links that open native apps leaving a stray blank tab.** Tapping an
  Apple Music (or similar) link handed off to the app from a popup tab rather
  than from Alloy, stranding it behind the app. Middle-click and
  modifier-click on links work again too.

## 0.4.9

- **Phones now use the mobile layout in landscape.** A phone turned sideways is
  wider than the old breakpoint, so it was being served the desktop layout on a
  viewport half the usual height. Large tablets and resized desktop windows are
  unaffected.
- **Fixed the composer taking over the screen in landscape.** Its height limit
  was a fixed size that happened to be about half a sideways phone screen, and an
  empty composer could stay stuck at the height it had before you rotated.
- **Fixed scrolling breaking after rotating the device.** Alloy measured the
  screen once, as the rotation began, and iOS reports its final size only after
  the animation finishes — so the app could keep sizing itself to the previous
  orientation.

## 0.4.8

- **Clear error when Alloy's network port is busy.** Sharing on the network needs
  a fixed port, so if another copy of Alloy still holds it — closing the window
  doesn't quit the app, and an update relaunch can leave the old process running
  — startup failed and was misreported as a broken vault, wiping your saved
  vault path. It now names the port, explains the likely cause, and tells you how
  to fix it.

## 0.4.7

- **Fixed Alloy forgetting your vault after a restart.** If the vault couldn't be
  opened at startup — a synced folder not mounted yet, a permissions problem, an
  unparseable config — Alloy erased the saved path and dropped you on the setup
  screen with a cryptic "The string did not match the expected pattern". It now
  keeps the vault, says what actually went wrong, and offers a retry.
- **The desktop app now logs.** It never installed a log subscriber, so failures
  in the embedded server produced no output anywhere, on stdout or otherwise.
  Launch the binary directly to read it; set `ALLOY_LOG=debug` for more.
- **New: install updates automatically** (Settings → Updates). Off by default and
  per-machine, so an always-on Mac sharing Alloy on the network can update itself
  without screen sharing in, while your laptop stays untouched. Updates only ever
  install at startup, never mid-session.

## 0.4.6

- **Codex can now use Alloy's tools.** The `codex-cli` provider reaches the same
  tool parity as Claude — reading notes, searching the vault, and everything else
  — over the MCP bridge both subscription providers now share.
- **The app no longer silently goes stale.** The file watcher only received
  events while connected and nothing was replayed for the gap, so anything that
  changed while the connection was down (routine on mobile: screen lock, app
  switch) was lost until a manual reload. Alloy now catches up on reconnect and
  when you return to it.
- **The model picker no longer hides behind the keyboard on mobile.** Opening it
  raised the software keyboard, which moved the composer out from under the
  already-positioned popover, leaving just the search box visible.
- **Images can no longer be attached to models that can't read them.** Codex is
  text-only, so attachments were dropped in silence and it answered as though
  nothing had been sent. Attaching is now blocked up front, with a warning if the
  model is switched while images are pending.

## 0.4.5

- **Camera photos are no longer stored rotated 90°.** Phones store portrait
  shots as landscape pixels plus an EXIF orientation tag that viewers apply on
  display. Alloy's image downscaler ignored that tag and then dropped it when
  re-encoding, so any photo larger than 1568px was saved sideways — in the
  composer, in the message, and for vision models, which were quietly reading a
  rotated image. The rotation is now baked into the pixels before resizing.
  Smaller images are still stored untouched, with their EXIF intact.

## 0.4.4

- **Much faster startup, especially on mobile.** Model discovery no longer
  blocks the first paint. On a large vault this cut time-to-usable from ~7s to
  ~0.5s; the model picker fills in on its own a moment later.
- **Model discovery results are cached even when a provider is down.**
  Previously a single unreachable provider (a sleeping local MLX box, say)
  disabled caching entirely, so every launch and every app-switch re-spawned the
  Claude and Codex CLIs and waited on connect timeouts. Partial results are now
  cached for a minute, so an offline provider still recovers quickly.
- **A hiccup in model discovery no longer claims the vault has no provider.**
  Whether providers exist is read from `config.yaml` rather than inferred from
  the live model list, and a transient empty result no longer blanks the model
  picker.
- Settings now shows the running Alloy version.

## 0.4.3

- Fixed unreadable syntax highlighting in dark-mode Markdown code blocks by
  replacing the light-only highlight.js palette with theme-aware semantic
  colors. Code surfaces, language labels, and copy controls now adapt to dark
  mode as well.
- Added desktop and mobile smoke coverage that enforces WCAG AA contrast for
  representative syntax tokens in dark mode.

## 0.4.2

- **Breaking: `config.yaml` version 2.** Subscription providers now use the
  unified `{ kind: cli, adapter: claude | codex }` shape. The old `cli_claude`
  and `cli_codex` kinds fail with migration guidance. Local trust is also
  explicit: only `local: true` on a private-network OpenAI-compatible endpoint
  grants the Local badge and private-directory access; CLI adapters are always
  cloud.
- **Live subscription model discovery.** Claude uses the structured catalog
  behind its `/model` picker, including account/policy filtering, resolved model
  names, and 1M context variants. Codex uses its authenticated app-server model
  catalog, identifies the current default, and exposes exact selectable models.
- Model search now includes provider names and badges, so searches such as
  `openai` find Codex subscription models and `anthropic` find Claude models.
- Claude subscription responses now expose extended thinking when the model uses
  it. Also fixed thinking-chevron alignment and prevented reasoning narration
  from leaking into generated conversation titles.
- Added a reproducible desktop/mobile seeded-vault Playwright smoke suite,
  independent Rust checks in CI, and a single `npm run verify` gate covering
  typecheck, lint, unit tests, Rust tests, and the production web build.

## 0.4.1

- **Conversation-list actions on mobile.** Each item in the sidebar now has a
  “⋯” button, and you can long-press an item, to open its actions (Rename /
  Delete / Reveal / Edit) — previously reachable only by right-click, which
  touch devices (especially iOS) can't do.
- **Codex subscription mode.** Use Codex billed against your ChatGPT/Codex
  subscription by adding a `cli_codex` provider (shells out to the `codex` CLI,
  `codex login` required). The picker shows a single Codex model that uses your
  plan's default. Text-only for now: it answers prompts in a read-only sandbox
  but doesn't use Alloy's built-in tools, and prompts go to OpenAI so it's
  treated as cloud.
- The reasoning ("Thinking…") disclosure and icon-button tooltips now use the
  accessible React Aria foundation, with proper keyboard and ARIA behavior.
- Under the hood: `config.yaml` parsing is consolidated in the Rust backend (one
  source of truth), and a model's on-device "local" badge now uses the same rule
  as private-directory access so the two can't disagree.
- Fixed the mobile composer collapsing to three rows — unusable with the
  keyboard up — after the model-picker rebuild.

## 0.4.0

- **Breaking: new `config.yaml` format.** All models are now configured under a
  single `providers:` list with camelCase keys; the old per-vendor `*_API_KEY`
  flat keys are gone. Cloud models are reached through OpenRouter, on-device
  models through an OpenAI-compatible endpoint marked `local: true` (prompts stay
  on your machine/LAN), and your Claude Pro/Max subscription through a
  `cli_claude` provider. There is no automatic migration — a pre-0.4 config is
  rejected at startup with a message showing the new shape. Update your
  `config.yaml` (keep a backup) before launching.
- **Dark mode**, with a Light / Dark / System setting under Settings → Appearance
  that follows your OS by default. Every surface is theme-aware.
- **Rebuilt model picker**: click to open a popover with the search field inside,
  full keyboard navigation, and per-row favorite stars.
- The sidebar type filter is now a row of tabs (All / Chats / Notes / Tasks /
  Riffs), and there's a **settings gear** in the header (Settings was previously
  only reachable via ⌘,).
- Removed the Ollama integration; connect a local model server (oMLX or any other)
  as a standard OpenAI-compatible endpoint instead.
- Under the hood: the UI now sits on an accessible component foundation (React
  Aria) with a semantic design-token system, improving focus handling, keyboard
  support, and consistency.

## 0.3.18

- Make the sidebar easier to scan: local-model conversations carry a `Local`
  badge, tasks carry a `Task` badge, and local tasks show both. Tasks now also
  display their configured model beside the date. Redundant colored edge rails
  were removed so overlapping labels stay unambiguous.

## 0.3.17

- Replace triggers with Scheduled Tasks: use five-field cron schedules with an
  explicit timezone, run tasks immediately from the UI, and optionally gate
  delivery on a model-evaluated condition. Missed schedules catch up once after
  downtime without replaying the full backlog.
- Show live model thinking when a provider supplies it (including oMLX reasoning
  and Claude CLI thinking). Thinking is collapsible, bounded, reconnectable while
  active, and never written to conversation files or included when copying the
  answer. Models without exposed reasoning still show a live thinking timer.
- Remove the unused Background mode and simplify the app around conversations,
  notes, riffs, and scheduled tasks.
- Fix development/server compilation when the production `dist-web` asset folder
  has not been built yet.

## 0.3.16

- Local models now treat a configured private vault (e.g. your Obsidian notes)
  as your primary knowledge base instead of the app's own `notes/` folder, so
  "any notes about X?" searches the right place. `privateReadOnlyDirs` entries
  take an optional `description` to label what each mount holds. Cloud models are
  unaffected and still never see these directories.

## 0.3.15

- Fix agents choking on large note vaults: `list_directory` and `search_directory`
  now return small, most-recent-first pages (with limit/offset paging) instead of
  dumping thousands of entries — a big directory used to produce a result too
  large for the model, taking many minutes. `list_directory` can list recursively;
  `read_file` is capped so one huge file can't flood the context.
- `search_directory` gains a fuzzy option (match all query words anywhere, in any
  order) and now scans the whole vault so a rare term in an old note is found.
- Private read-only mounts support `excludeDirs` in config.yaml, so e.g. a nested
  Alloy vault is kept out of your Obsidian-vault searches.

## 0.3.14

- Much faster startup, especially on mobile: the conversation list now loads
  metadata only (one batched read) instead of parsing every conversation's full
  history up front. A conversation's messages load when you open it.
- Local oMLX models get far better prompt-cache reuse: the system
  prompt no longer leads with a per-second timestamp (which changed every turn),
  so cached prefixes actually stick.
- Assistant replies now show how long they took, next to the token count.
- Queued messages: the text is selectable/copiable, and several messages queued
  while a reply is streaming are sent as one combined follow-up (one reply, not
  one per line). A queued message no longer briefly disappears before its reply.
- Upstream request failures now show the real cause (e.g. "Connection refused")
  instead of a generic "error sending request" message, and errors are copiable.

## 0.3.13

- Add local MLX support: point Alloy at an on-device or LAN MLX server (e.g.
  oMLX or `mlx_lm.server`) with a `providers:` block in `config.yaml` — its
  models are discovered automatically and show up in the picker.
- The model picker now tags each model with its provider (OR, MLX, ANT, …) and
  marks on-device models with a green padlock, so it's clear when your prompts
  stay off the cloud. Claude subscription models drop the "(subscription)"
  suffix (the ANT tag already says it).
- Chat errors now have a copy button to grab the full message for debugging.

## 0.3.12

- Add `/skill_name` slash commands: type `/` in the composer to pick a skill
  from an autocomplete menu and run it directly on your message (works across
  all models, including Claude subscription).
- Fix your vault's own skills not appearing (only the built-in ones showed).
- Stop long model names like "Claude Opus (subscription)" from shrinking the
  message box.

## 0.3.11

- Claude subscription models now use the same built-in tools as every other
  provider — web search, reading/writing vault files, notes, and skills — instead
  of Claude Code's own tools. Tool activity shows as the usual pills.
- Fix subscription mode failing to start in the installed app with a "claude not
  on PATH" error: Alloy now finds the `claude` binary in its standard install
  locations even when launched from Finder/Dock (which don't inherit your shell
  PATH). You can still pin it with `CLAUDE_CODE_PATH` in `config.yaml`.

## 0.3.10

- Add a Claude subscription provider: pick Claude Opus/Sonnet/Haiku billed
  against your Claude Pro/Max subscription (via the Claude Code CLI) instead of
  API credits. Enable it with `CLAUDE_SUBSCRIPTION: true` in `config.yaml` —
  requires the `claude` CLI installed and logged in to your subscription.
- These subscription models can use Claude Code's read-only and web tools —
  web search/fetch and reading your vault notes — surfaced as the same tool
  pills as other providers. Editing files and running shell commands are not
  permitted.

## 0.3.9

- Fix interrupting a response (pressing escape, or a mid-turn error) discarding
  the whole turn — including web searches that had already run — and leaving the
  message with no reply. The turn is now kept with whatever it produced.

## 0.3.8

- Fix assistant responses that used tools sometimes saving with blank content:
  the text streamed live but the persisted message came out empty. The saved
  text now matches exactly what was shown.
- Web searches beyond the per-response cap of 3 no longer appear as empty
  search pills in the transcript.

## 0.3.7

- Cap web searches at 3 per response: the model was firing far more web
  searches than questions warranted. After the third, it answers from the
  results it already has instead of searching again.

## 0.3.6

- Fix find-in-page (Cmd+F): the find bar had been hidden behind the
  conversation header since 0.3.1, so it never appeared. It now shows just
  below the header, with the active match highlighted distinctly from the rest.
- Add Cmd+G / Cmd+Shift+G to jump to the next / previous match while finding.
- Downscale oversized image uploads when saving them (max 1568px on the longest
  side), keeping the vault and the payloads sent to models smaller.

## 0.3.5

- Add automatic compaction for long conversations: older turns are folded into
  a running summary so the context sent to the model (and its cost) stays
  bounded. The full history is always kept and shown.
- Fix tool-use pills disappearing after a conversation reloads — tool calls are
  now persisted with the assistant message instead of only shown live.

## 0.3.4

- Fix background mode failing with "does not support chat": embedding-only
  local models are no longer offered as chat models, and a
  conversation left pointing at an unavailable model is healed to a valid one
  on load.
- Fix a spurious "defaultModel isn't available" error on startup: a transient
  model-list fetch failure no longer gets cached and degrade the app for an
  hour.

## 0.3.3

Maintenance release to verify the auto-updater fixed in 0.3.2 works end to end
(detect → download → install → relaunch). No user-facing changes.

## 0.3.2

Fixes the in-app auto-updater, which was silently broken in 0.3.0 and 0.3.1 —
the bundled app never detected or applied updates.

⚠️ If you're on 0.3.0 or 0.3.1, you must update to 0.3.2 **manually this one
time**: download the app below and install over your current copy. Those
versions can't auto-update themselves. Once you're on 0.3.2, auto-updates work
normally again.

- Fix the auto-updater: the updater and process plugin shims were stubbed out
  for the bundled app once the build was unified in 0.3.0, so update checks
  always returned "none" and installs couldn't relaunch the app.
- Fix new conversations bouncing to the background view after the first reply.

## 0.3.1

- Notes: read-only viewer, external-editor editing, and full-text search.
