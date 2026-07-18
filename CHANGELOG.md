# Changelog

All notable changes to Alloy are documented here. The release workflow
publishes the section matching each version tag (e.g. `## 0.3.2`) as the body
of the corresponding GitHub release, so add a section here before bumping.

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
- Local models (oMLX/Ollama) get far better prompt-cache reuse: the system
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

- Fix background mode failing with "does not support chat": Ollama embedding
  models (e.g. mxbai-embed-large) are no longer offered as chat models, and a
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
