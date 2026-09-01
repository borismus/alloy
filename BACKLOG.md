# Backlog

Tasks for the autonomous backlog runner (`scripts/backlog-runner.sh`).
Each `- [ ]` is one self-contained task. The runner picks the first open one,
works it on an `auto/<slug>` branch, verifies, and opens a PR for review.

Keep tasks small and unambiguous — one PR's worth of work each. Completed work
and the mobile-reliability checklist are archived in
[`docs/backlog-archive.md`](docs/backlog-archive.md).

- [ ] Add native PDF attachments to conversations. Generalize the current image-only `Attachment`, pending-composer, queue, vault-storage, and server message types to support `document` attachments while preserving every existing image path. Accept `application/pdf` from the file picker and drag-and-drop, store the original PDF under `conversations/attachments`, and render an accessible filename chip before and after sending. Add a provider/model `supportsDocuments` capability and send PDFs only through verified native document protocols (initially Claude subscription and OpenRouter); unsupported providers such as Codex app-server and oMLX must block the attachment with a clear explanation rather than silently dropping it or uploading it elsewhere. Respect each upstream size/page limit, keep vault paths private, and never fall back from a local provider to cloud. Cover Tauri and browser/server modes with unit tests for capability gating and wire shapes plus a smoke test using a real small PDF.
- [ ] Implement manual conversation compaction end to end, then restore the **Compact now** action in the context-usage popover. Add an authenticated backend route that compacts the selected persisted conversation using the existing server-owned compaction/model-selection machinery, writes the compacted boundary atomically without dropping attachments, tool history, newer turns, or concurrent optimistic user messages, and returns the updated conversation. Reuse the automatic-compaction format and provider-native one-shot model behavior rather than creating a second summary schema. The client action must show progress, reload the resulting conversation, preserve scroll sensibly, and surface failures without leaving a false compacted state. Keep automatic compaction unchanged and cover Tauri and browser/server modes with Rust route/persistence tests and a frontend interaction test. Do not expose a placeholder button before the backend path works.

## Future epics (not scheduled — no `- [ ]`, so the runner skips them)

- **Plugin architecture** — return Alloy to an extensible, plugin-oriented app.
  Core model: **Resource → Workspace → Host capabilities**. Dogfood the extension
  API with first-party Notes, Tasks, Comparison, Council, Riff, and eventually
  Chat modules; add an **MCP client** for external capabilities and declarative
  vault packs as the no-code on-ramp. Full design, boundaries, trust model, and
  sequencing in [docs/plugin-architecture.md](docs/plugin-architecture.md).
