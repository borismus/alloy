# Plugin Architecture (Future Epic)

**Status:** Imagined for a future release — not scheduled
**Date:** 2026-07-27

## Goal

Return Alloy to an extensible, plugin-oriented app. The original vision was "an
extensible app with a bunch of plugins"; the recent move of tool/model logic into
the compiled Rust backend (`alloy-server`) made the app cleaner but *less*
dynamically pluggable. This epic reconciles the two: keep the Rust backend, and
add extension points back on top of it.

## Where extensibility stands today

- **Skills** (`src/services/skills/loader.ts`) — markdown `SKILL.md` folders in
  `vault/skills/`, hot-loaded, prompt-level. The one *live* extension surface —
  but skills only *orchestrate existing tools*; they can't add new capabilities.
- **Tools** (`alloy-server/src/tools/mod.rs`) — a hardcoded Rust `match`
  (`web_search`, `read_file`, `spawn_subagent`, …). Adding one means editing the
  match + a module + recompiling. **This is what changed** — tools moved from TS
  into compiled Rust.
- **MCP** (`alloy-server/src/routes/mcp.rs`) — Alloy is an MCP *server* (exposes
  its tools to the Claude Code CLI). It is **not** an MCP *client*.
- **Providers** — compiled `ProviderKind` enum; `openai_compatible` is generic,
  the rest are recompile-to-add.
- **Features/modes** — riff is fully hardcoded: `RiffService` (~790 lines) +
  `RiffProvider` context + `RiffView` + `RiffBatchApprovalModal` + the `riffs/`
  vault convention + ~20 hook points in `App.tsx`. That wiring *is* a de-facto
  "feature plugin API," just not named as one.

## Recommended model: three plugin types for three needs

### 1. Capabilities → MCP client (the backbone)

Flip the arrow: Alloy already *serves* MCP, so make it *consume* MCP servers
listed in config, merging their tools into the tool loop next to the built-ins
(a dynamic branch in `alloy-server/src/tools/mod.rs`'s match).

- **Why:** MCP is the industry-standard AI plugin format (Claude Desktop, Cursor,
  Zed), so the whole MCP ecosystem becomes Alloy plugins for free, and it restores
  dynamic tool extensibility **without** giving up the Rust backend (servers are
  separate processes — sandboxed by construction).
- **Trade-off:** process lifecycle to manage; extends *capabilities*, not UI —
  riff can't be an MCP server.

### 2. Modes → a first-class `Feature` interface (council/comparison first, then riff)

Name the thing riff already does: a `Feature` registers a sidebar entry, a
multi-model or custom input, an execution strategy, a response view, persistence,
and an enter/exit lifecycle.

**Design the interface from council + comparison, not riff.** Both were fully
implemented and removed in `028ada8` ("Remove comparison and council features",
~3,267 LOC across `ComparisonChatInterface`/`ComparisonView`/`CouncilChatInterface`,
`useComparisonStreaming`/`useCouncilStreaming`, multi-model selectors, and vault
serialization). They were removed on the theory that sub-agents subsumed them —
but sub-agents are the **wrong abstraction level**:

- **Sub-agents = model-initiated delegation.** The parent model decides to spawn
  one; the sub-agent's output feeds *back into the parent*, which digests it into
  a single answer. The user never sees raw parallel model output.
- **Council/comparison = user-initiated survey.** The *user* picks the models;
  comparison shows every model's raw answer side-by-side (no synthesis), council
  shows members plus an explicit **chairman** synthesis. Sub-agents structurally
  can't do "show me what three models say," which is why they "don't work well
  enough."

**Why they're the ideal first Feature plugins:** they're *pure frontend
compositions of the existing single-model stream primitive* — comparison = N
parallel `/api/stream` calls rendered side-by-side; council = N member calls +
one chairman call over their outputs. No new backend surface, no new tools, no
privacy concerns. Two fresh cases (plus riff) is enough to shape the interface
without over-fitting.

**The revival is restore + re-plumb, not green-field.** The old code is at
`028ada8^` (`git show 028ada8^:src/hooks/useCouncilStreaming.ts`, etc.). The one
real change: the old hooks fanned out via the client-side `providerRegistry`,
which is gone — rewire the fan-out through the server stream endpoint
(`src/services/server-streaming.ts`). View, model selector, phases (`individual`
→ `synthesis`), chairman prompt, and per-message `model`/`councilMember`/
`chairman` tagging port largely as-is.

- **Trade-off:** third-party *frontend* plugins mean loading untrusted React →
  security/bundling hazard, so this is **internal-first** (our own modes as
  plugins); external third-party modes are a later, separate step.

### 3. On-ramp → declarative capability packs (skills++)

A `vault/plugins/<name>/` folder with a manifest that bundles instructions
(skill), scheduled tasks, prompt templates, and HTTP/OpenAPI-described tools — no
code.

- **Why:** safe (declarative), hot-loadable via the existing vault watcher
  (`useVaultWatcher`), and shareable as plain files (fits the vault-as-files
  ethos).
- **Trade-off:** declarative ceiling — can't express riff's interactive diff UI
  (that's what layer 2 is for).

## Non-goals / deferred

- **WASM plugins** — sandboxed third-party logic via wasmtime is powerful but
  heavy (toolchain + host-API design). MCP delivers sandboxed external tools far
  cheaper; revisit only if MCP's limits are hit.
- **Third-party frontend feature plugins on day one** — loading untrusted React
  is a security/bundling minefield; do the internal `Feature` refactor first.

## Possible later: agent-authored plugins

Alloy already has `write_file` + `create_scheduled_task`, so it could *scaffold
its own plugins* — "make me a mood tracker" → it writes a declarative pack (task
+ note schema + a small view) into the vault and hot-loads it. Depends on the
layer-3 substrate + guardrails.

## Sequencing (when scheduled)

1. **Revive comparison** (simplest: parallel fan-out, side-by-side, no synthesis)
   — restore from `028ada8^`, re-plumb to the server stream. Smallest useful slice.
2. **Revive council** (reuses comparison's multi-model input + fan-out, adds the
   chairman synthesis phase).
3. **Extract the shared shape into a `Feature` interface**, then retrofit **riff**
   (the most entangled mode) onto it — informed by the two simpler cases.
4. **MCP client** for tools (capability backbone) — independent; can run in parallel.
5. **Declarative capability packs** (no-code on-ramp).
6. *(optional)* **Agent-authored packs.**
