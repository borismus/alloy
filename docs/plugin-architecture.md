# Plugin Architecture RFC (Future Epic)

**Status:** Proposed — not scheduled
**Date:** 2026-07-27

## Goal

Return Alloy to an extensible, plugin-oriented app without giving up the Rust
backend, local-first vault, privacy boundary, or desktop/browser parity.

The core model is:

> **Resource → Workspace → Host capabilities**

Everything visible in Alloy's timeline is a resource supplied by an extension.
Selecting a resource opens the extension's workspace. Alloy's kernel supplies
mechanisms (vault access, model runs, scheduling, navigation, permissions, and
UI primitives), not product-specific resource types.

"Plugin" initially means a first-party module built against extension APIs. It
does **not** initially mean removable, dynamically downloaded, or trusted to run
arbitrary code. Modularity and installability are separate decisions.

## Vocabulary

- **Resource** — a persisted item with an identity and timeline summary: a chat,
  note, task, riff, comparison study, or council study.
- **Workspace** — the main-panel UI and controller for a resource. It may be a
  viewer, editor, one-shot model run, staged workflow, or ongoing conversation.
- **Extension** — a versioned bundle of contributions: resource types,
  workspaces, commands, context actions, settings, or job/tool definitions.
- **Host capability** — a stable service supplied by Alloy: model execution,
  scoped vault I/O, reviewed change sets, background scheduling, navigation,
  dialogs, and so on.

## First-party extensions

| Extension | Resource/storage | Workspace boundary |
|---|---|---|
| **Chat** | `conversations/*.yaml` | Multi-turn chat, attachments, compaction, sub-agents |
| **Notes** | `notes/*.md` | Render a Markdown note; edit it through the reviewed LLM edit flow |
| **Tasks** | `tasks/*.yaml` | Render/edit task configuration and history; run it now |
| **Riff** | `riffs/*.md` | Long-lived draft/artifact workspace; propose integration into notes |
| **Comparison** | structured one-shot study | One prompt, N parallel model responses, side-by-side result |
| **Council** | structured one-shot study | One prompt, N member responses, then chairman synthesis |

This table deliberately makes Notes and Tasks first-class examples. Their clean
boundaries prevent the API from being designed only around elaborate AI modes.

### Notes boundary

The Notes extension owns:

1. Discovery and metadata for `notes/*.md`.
2. The note workspace (`NoteViewer`).
3. LLM-assisted editing and the note-specific prompt/schema.
4. Note actions such as opening in the external editor.

The host owns safe file access, atomic writes, model execution, the reviewed diff
interaction, shared Markdown rendering, navigation, and watcher delivery.

Notes must not know about Riff. The current `NoteViewer.onIntegrate` coupling
becomes a context action registered by the Riff extension.

### Tasks boundary

The Tasks extension owns:

1. The scheduled-prompt document schema and validation.
2. The task workspace (`TaskDetailView`).
3. Task-specific editing, history presentation, and Run Now command.
4. Task tool definitions such as `create_scheduled_task` and
   `update_scheduled_task`.

The host owns the cron clock, timezone parsing, claim/deduplication semantics,
atomic persistence, model execution, background process lifetime, and delivery
reliability. Initially the existing compiled Rust implementation under
`alloy-server/src/tasks/` remains the host adapter; extracting the frontend does
not require a generic scheduler rewrite.

External task extensions should eventually use declarative scheduled model/tool
runs or MCP-backed jobs — not dynamically loaded Rust libraries.

### Comparison and Council are one-shot workspaces

Comparison and Council were fully implemented, then removed in `028ada8` on the
theory that sub-agents replaced them. They solve a different problem:

- **Sub-agents** are model-initiated delegation; their results feed back into one
  parent answer.
- **Comparison/Council** are user-initiated multi-model surveys; the user chooses
  the models and sees the independent outputs.

They should return as **durable one-shot studies**, not special multi-turn
conversations:

- Comparison: one prompt → parallel responses → complete.
- Council: one prompt → parallel member responses → chairman synthesis → complete.
- No follow-up composer inside the completed workspace.
- Explicit actions provide continuation: **Continue in Chat**, **Send to Riff**,
  **Save as Note**, **Duplicate and Rerun**, or **Run Follow-up Study**.

This avoids the old flattened `Message[]` model, where multiple assistant
responses were appended sequentially and then fed back to every model on the
next turn. Study results should persist as explicit structured stages/outputs.

"One-shot" does not mean ephemeral: a study is saved when it starts so it can
survive reloads, reconnect to active model runs, retain partial failures and
usage, and reopen from the timeline.

### Riff boundary

Riff is a long-lived resource workspace rather than a one-shot study. It owns its
draft schema, artifact behavior, interventions, and integration strategy. The
host supplies model runs, scoped vault access, file watching, navigation, and a
generic reviewed change-set service.

Riff's `ProposedChange` + approval modal should become a host capability reusable
by note/task editing, research plugins, and future vault-maintenance extensions.

## Extension and resource contracts

Illustrative TypeScript — enough to define the boundary, not a frozen API:

```ts
interface AlloyExtension {
  manifest: {
    id: string;
    version: string;
    apiVersion: number;
    capabilities: CapabilityRequest[];
  };

  activate(host: ExtensionHost): Disposable;
}

interface ResourceRef {
  kind: string; // e.g. "alloy.note", "alloy.council"
  id: string;
}

interface ResourceType<T> {
  kind: string;
  schemaVersion: number;

  repository: {
    list(): Promise<ResourceSummary[]>;
    load(id: string): Promise<T>;
    save(resource: T): Promise<void>;
    delete(id: string): Promise<void>;
    watchPatterns: string[];
  };

  toTimelineEntry(resource: T): TimelineEntry;
  create?: (seed: unknown, host: ExtensionHost) => Promise<ResourceRef>;
  Workspace: React.ComponentType<ResourceWorkspaceProps<T>>;
  actions?: ResourceAction[];
}
```

An extension activates by registering contributions rather than reaching into
`App.tsx`:

```ts
host.resources.register(noteResourceType);
host.commands.register(...);
host.contextActions.register(...);
host.settings.registerSection(...);
```

## Host capabilities

Extensions use stable host APIs rather than importing `vaultService`, calling
`/api/stream` directly, or importing Tauri plugins. This is mandatory for both
Tauri and browser/server modes.

```ts
interface ExtensionHost {
  resources: ResourceHost;
  models: ModelHost;
  runs: RunHost;
  vault: ScopedVaultHost;
  changes: ChangeSetHost;
  jobs: JobHost;
  commands: CommandHost;
  contextActions: ContextActionHost;
  navigation: NavigationHost;
  dialogs: DialogHost;
  events: EventHost;
  settings: SettingsHost;
  ui: AlloyUiComponents;
}
```

### Model runs and reliability

`executeViaServer()` is a useful implementation primitive but not yet a stable
extension API: it creates session IDs internally and does not expose a durable,
reconnectable run handle. The host model API should return handles tagged with
the owning extension, resource, and run:

```ts
const run = await host.models.start({
  owner: { extensionId, resource, runId },
  model,
  messages,
  tools: "none",
  persistence: "manual",
});

run.subscribe(...);
run.cancel();
await run.result;
```

Comparison and Council model calls use manual persistence; N parallel server
sessions must not independently append to the same YAML file. The workspace
atomically commits the structured result. Council controls the member → chairman
sequence through host-owned run handles and can resume that sequence after a
reload.

Do not build a generic workflow/DAG language initially. Tagged, reconnectable
model runs are sufficient for the first-party workspaces.

### Reviewed change sets

Cross-resource writes should go through a host service:

```ts
await host.changes.propose({
  title: "Integrate research into notes",
  changes,
});
```

The host renders the review UI, applies accepted changes atomically, and enforces
the extension's declared scopes.

### Capabilities and privacy

Example Riff capabilities:

```yaml
capabilities:
  - models.invoke
  - vault.read: [riffs/**, notes/**]
  - vault.write: [riffs/**]
  - vault.proposeWrite: [notes/**]
```

Vault path validation, the `local: true` privacy boundary, private-directory
access, and atomic writes remain kernel responsibilities. External MCP servers
receive no vault access unless explicitly granted.

## Cross-extension communication

Extensions communicate through resources, commands, context actions, and host
services — never by importing another extension's component or service.

Examples:

```ts
host.commands.execute("alloy.chat.continue", { context: taskRef });
host.commands.execute("alloy.riff.create", { seed: councilResult });
host.resources.open({ kind: "alloy.note", id: "project.md" });
```

This replaces current callback coupling such as:

- `NoteViewer.onIntegrate` (Notes knowing Riff).
- `TaskDetailView.onAskAbout` (Tasks knowing Chat).
- Riff receiving notes/conversations/navigation through many `App.tsx` props.

Dependencies should be declared and optional where possible. If Riff is absent,
its Note context action simply is not registered.

## Kernel boundary

The Alloy kernel owns:

- Extension/resource registries and lifecycle/error isolation.
- Timeline aggregation, search, navigation, and mobile/desktop shell.
- Vault path enforcement, atomic I/O, file watching, and self-write handling.
- Model/provider discovery, durable runs, streaming, cancellation, and reconnect.
- Background scheduler and job claims.
- Permission and privacy enforcement.
- Commands, context actions, settings contributions, dialogs, and toasts.
- Shared React Aria components, theme, and rendering primitives.
- Config parsing and MCP client/server infrastructure.

The kernel should not contain product-specific branches for Note, Task, Riff,
Comparison, or Council. Standard Chat should eventually use the same resource
contract too, but migrate last because it currently owns the broadest surface
(streaming, queues, attachments, compaction, sub-agents, and provenance).

## What the registry replaces

Today resource knowledge is repeated in:

- `SelectedItem` and `TimelineItem` closed unions (`src/types/index.ts`).
- Main-panel conditionals and resource handlers (`src/App.tsx`).
- Filters, badges, context menus, and create actions (`src/components/Sidebar.tsx`).
- `vaultService.buildTimeline()` and type-specific CRUD.
- Hardcoded path classification in `useVaultWatcher()`.
- Global feature providers such as `RiffProvider`.

With a registry:

- `App.tsx` resolves `ResourceRef.kind` and renders the registered workspace.
- Sidebar aggregates registered timeline entries, filters, badges, and actions.
- The watcher publishes events to registered path subscriptions.
- Each workspace owns instance state behind an error boundary.
- Disabling or failing one extension cannot crash the shell; unknown resources
  retain their files and display an unavailable/read-only fallback.

## Extension runtimes

Do not force every extension into one execution runtime:

1. **First-party workspace extensions** — bundled TypeScript UI plus compiled
   host adapters where needed. Notes, Tasks, Comparison, Council, Riff, and Chat
   dogfood the extension API.
2. **Capability extensions via MCP client** — external tools/processes discovered
   by the Rust backend and merged into the tool registry with trust controls.
3. **Declarative vault packs** — `vault/plugins/<name>/` manifests bundling
   skills, prompts, task templates, and safe HTTP/OpenAPI/MCP tool declarations.
4. **External UI extensions** — deferred. If added, use a sandbox or
   host-rendered declarative UI; do not load arbitrary React directly into the
   main app process.

A future extension package may bundle several contribution types, but the host
APIs and trust boundaries remain distinct.

## Non-goals for v1

- Making first-party extensions uninstallable or downloadable.
- Arbitrary third-party React execution in the Alloy process.
- Dynamically loaded Rust libraries.
- Moving vault/privacy enforcement into extensions.
- A universal file format; existing human-readable folders remain valid.
- A general-purpose workflow/DAG engine.
- Migrating every feature in one release.

## Sequencing

1. **Resource registry foundation** — open `ResourceRef`, workspace resolution,
   registered timeline metadata/actions/watch patterns, host APIs, and per-plugin
   error boundaries. Preserve current behavior.
2. **Notes extension** — the smallest boundary: render Markdown + reviewed LLM
   editing. Remove Note/Riff direct coupling via context actions.
3. **Tasks extension** — move its resource/workspace UI behind the registry while
   keeping the existing Rust scheduler as a host adapter. Replace Ask About with
   a Chat command.
4. **Comparison extension** — revive from `028ada8^` as a durable one-shot study,
   re-plumbed to host model-run handles and structured persistence.
5. **Council extension** — reuse multi-model presentation/run primitives and add
   the recoverable chairman stage.
6. **Riff extension** — move its resource, workspace state, watcher, integration
   actions, and overlays behind host capabilities; extract reviewed change sets.
7. **Chat extension** — migrate the standard conversation workspace last.
8. **Freeze Extension API v1** only after all six first-party extensions have
   exercised it.
9. **MCP client and declarative packs** can proceed independently once their host
   permission/config surfaces are defined.

Avoid a big-bang rewrite: each extracted extension must preserve its vault
format, desktop and browser/server behavior, mobile layout, watcher semantics,
and interaction tests.

## Future extension ideas enabled by this shape

- **Research Expedition** — parallel researchers → evidence/disagreement matrix
  → reviewed Riff/Note integration.
- **Vault Gardener** — local-first orphan/contradiction/staleness analysis with
  proposed changes rather than silent writes.
- **Decision Room** — criteria matrix, independent scoring, disagreement heatmap,
  and judge recommendation.
- **Model Lab** — prompt datasets across models with quality, latency, token, and
  cost comparisons.
- **Review Board** — context action on a message/note/task that runs critics and
  proposes a corrected diff.
- **Watchtower** — reusable scheduled monitors and delivery adapters.
- **Artifact Foundry** — host-rendered charts, maps, timelines, and other Riff-like
  artifact workspaces.
- **Plugin Smith** — Alloy scaffolds declarative extensions with a permission
  preview before installation.
