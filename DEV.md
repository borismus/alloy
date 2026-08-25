# Alloy Development Notes

## Quick Start

```bash
# Make sure Rust is in your PATH (after fresh install)
source $HOME/.cargo/env

# Install dependencies
npm install

# Run in dev mode
npm run tauri dev
```

## Project Structure

```
alloy/
├── src/                      # React frontend
│   ├── components/           # Feature UI components
│   │   ├── ui/               # Alloy-owned React Aria primitives + CSS Modules
│   │   ├── ChatInterface.tsx # Main chat UI
│   │   ├── RiffView.tsx      # Draft note editing
│   │   ├── Sidebar.tsx       # Timeline and vault search
│   │   └── Settings.tsx      # Settings panel
│   ├── services/             # Business logic
│   │   ├── vault.ts          # File system operations
│   │   ├── riff.ts           # Draft integration logic
│   │   ├── server-streaming.ts # Backend stream client
│   │   ├── skills/           # Skill loading and execution
│   │   ├── context/          # Context window estimation
│   │   └── api/              # HTTP shims for Tauri plugins (web + Tauri)
│   ├── contexts/             # React contexts
│   ├── hooks/                # Custom hooks
│   ├── styles/tokens.css     # Semantic light/dark design tokens
│   ├── types/                # TypeScript types
│   └── App.tsx               # Main app component
│
├── alloy-server/             # Rust (axum) backend: model calls + tool execution
│   ├── src/                  # Routes, providers, tools, streaming (see its README)
│   └── Cargo.toml            # Rust dependencies
│
├── src-tauri/                # Tauri desktop shell (embeds alloy-server)
│   ├── src/
│   │   └── lib.rs            # Tauri app setup
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri configuration
│
└── package.json              # Node dependencies

```

## Key Technologies

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Tauri 2 (Rust)
- **AI**: OpenAI-compatible services (including OpenRouter/oMLX) plus Claude and Codex subscription adapters
- **Storage**: YAML/Markdown vault files; Rust is the sole `config.yaml` parser
- **Styling**: Semantic tokens, Alloy-owned React Aria primitives, CSS Modules for shared UI, and tokenized feature CSS

## Roadmap

Active tasks live in [BACKLOG.md](BACKLOG.md). Larger, not-yet-scheduled
directions:

- **Plugin architecture** — returning Alloy to an extensible, plugin-oriented app
  around **Resource → Workspace → Host capabilities**, dogfooded by first-party
  Notes, Tasks, Comparison, Council, Riff, and Chat extensions; external tools
  arrive through an MCP client and declarative vault packs. See
  [docs/plugin-architecture.md](docs/plugin-architecture.md).

One-off design decisions are recorded in [docs/design-decisions.md](docs/design-decisions.md).

## Development Flow

1. **Frontend changes**: Hot-reloaded automatically by Vite
2. **Rust changes**: Requires rebuild (Tauri watches and rebuilds)
3. **Config changes**: May require restart

## Testing

- `npm run test:run` — unit tests (Vitest, `*.test.ts(x)` alongside source).
- `cd alloy-server && cargo test` — Rust backend tests.
- `npm run test:e2e` — Playwright against `npm run dev` (uses your `.env` vault).
- `npm run test:smoke` — **seeded-vault smoke suite**. Builds `dist-web`, then
  boots the standalone `alloy-serve` against a fresh copy of
  `tests/smoke/fixture-vault/` (via `scripts/smoke-server.sh`) and runs
  `tests/smoke/` at desktop **and** mobile-emulated viewports
  (`playwright.smoke.config.ts`). Single origin — the backend serves both the
  embedded SPA and `/api`, exactly like the shared/standalone app a phone hits.
  This is the layer unit tests can't reach: does the app render with data, and
  does the mobile layout hold (e.g. the composer stays two rows). No API keys or
  personal vault needed; the fixture uses a subscription-CLI provider so the
  backend falls back to a curated Claude list when the CLI is unavailable in CI.
  Each run copies the fixture to a temp dir, so the checked-in fixture is never
  dirtied.

`npm run verify` runs typecheck, lint, frontend unit tests, Rust tests, and the
production web build. CI (`.github/workflows/ci.yml`) runs those concerns plus
the seeded smoke suite on every pull request and push to `main`.

## Dual Runtime Modes

The app runs in two modes:

- **Tauri mode** (`npm run tauri dev`): Native desktop app. The Tauri shell embeds the Rust `alloy-server` on a random loopback port; the SPA in the webview talks to it over `/api/*`.
- **Server mode** (`npm run dev`): Web browser mode at `http://localhost:1420`. One command runs the Vite frontend **and** the auto-rebuilding `alloy-server` backend (cargo-watch) together; Ctrl-C stops both. The backend's vault comes from `ALLOY_VAULT` in `.env` (override per-run with `ALLOY_VAULT=… npm run dev` or `npm run dev -- <vault>`). It binds `:3030` and Vite proxies `/api` to it. The dev port is deliberately **not** 3001, so it never collides with — or silently proxies into — an installed Alloy app holding `:3001`. Override with `ALLOY_DEV_PORT`.

In both modes, model calls and tool execution happen in `alloy-server`. All builds route Tauri plugin imports to HTTP shims under `src/services/api/` (via `vite.config.ts` aliases); each shim forwards to the real native plugin under Tauri, else degrades to a browser/`/api` fallback. When adding features that use Tauri APIs or make HTTP requests, ensure they work in both modes.

## API Integration

Provider configuration lives in the vault's `config.yaml`. HTTP API keys are
sent only to their configured upstream provider. Subscription adapters use the
locally installed Claude/Codex CLI authentication and are still cloud providers:
prompts leave the machine.

## File Formats

### Conversation (YAML)
```yaml
id: 2025-06-15-1750012200-bike-kickstand
created: 2025-06-15T11:30:00Z
model: anthropic/claude-opus-4-6
messages:
  - role: user
    timestamp: 2025-06-15T11:30:00Z
    content: Hello!
  - role: assistant
    timestamp: 2025-06-15T11:30:05Z
    content: Hi there!
```

### Config (YAML, v2)
```yaml
version: 2
defaultModel: openrouter/anthropic/claude-sonnet-4-6

providers:
  - id: openrouter
    kind: openai_compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-or-v1-...
  - id: mlx                       # local, on-device
    kind: openai_compatible
    baseUrl: http://localhost:8000/v1
    local: true
  - id: claude-cli                # Claude subscription
    kind: cli
    adapter: claude
  - id: codex-cli                 # ChatGPT/Codex subscription
    kind: cli
    adapter: codex

# Optional
serperApiKey: ...
sonioxApiKey: ...
```

### Memory (Markdown)
```markdown
# Memory

## About me
- Your context here

## Preferences
- Your preferences here
```

## Building for Production

```bash
npm run tauri build
```

Output locations (macOS):
- DMG: `src-tauri/target/release/bundle/dmg/`
- App: `src-tauri/target/release/bundle/macos/`

## Debugging

### Frontend Console
Open DevTools in the Tauri window (right-click → Inspect Element)

### Rust Logs
Check terminal where you ran `npm run tauri dev`

### File Operations
All vault operations can be inspected by looking at the files in your vault folder

## Tips

- **Fast iteration**: Keep `npm run tauri dev` running
- **Test persistence**: Check your vault folder to verify files
- **Web mode**: `npm run dev` for faster iteration — Vite frontend + auto-rebuilding `alloy-server` on :3030, one command (vault from `.env`)
- **Search**: Sidebar body search runs server-side through `/api/search`; do not eagerly load vault bodies into React state
- **Memory**: Edit `memory.md` to customize AI context

## Common Issues

**Build fails**: Make sure Rust is installed and in PATH
**API errors**: Check your API keys in `config.yaml` or the Settings panel
**Files not saving**: Verify vault folder permissions
**Search not working**: Check the standalone/embedded backend logs and `/api/search?q=...` response

---

Built with lateral thinking & withered technology
