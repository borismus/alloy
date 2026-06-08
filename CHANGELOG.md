# Changelog

All notable changes to Alloy are documented here. The release workflow
publishes the section matching each version tag (e.g. `## 0.3.2`) as the body
of the corresponding GitHub release, so add a section here before bumping.

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
